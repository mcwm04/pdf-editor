// Rebuilds a page's content stream with object edits applied: hidden objects are removed, moved /
// resized / re-worded objects are removed from their old place and re-drawn at the end of the page.
import { fmtNum, fmtOperand, hexOf } from './lexer';
import { PageAnalysis, PageObj, Run, M, mul, fmtM, apply } from './analyze';
import { bytesOfCodes, FontInfo } from './fontinfo';

export interface ObjEdit { hidden?: boolean; dx?: number; dy?: number; sx?: number; sy?: number; text?: string }
export type ObjEdits = Record<string, ObjEdit>;

export interface FallbackFont { key: string; encode(text: string): string /* hex */ }
export interface RewriteHooks {
  /** A standard font added to the page's resources, for text the original font cannot show. */
  fallbackFont(f: FontInfo | null): Promise<FallbackFont>;
}
/** Text that needs the Unicode writer (Urdu): drawn as an annotation after the rewrite. */
export interface ExtraText { x: number; y: number; w: number; size: number; color: string; text: string; bold: boolean }

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

export const isEdited = (e?: ObjEdit) => !!e && (e.hidden || e.dx || e.dy || (e.sx ?? 1) !== 1 || (e.sy ?? 1) !== 1 || e.text != null);

/** Transform for an edit, in PDF user space: scale about the object's top-left corner, then move. */
export function editMatrix(an: PageAnalysis, o: PageObj, e: ObjEdit): M {
  const ax = an.ox + o.bbox.x, ay = an.top - o.bbox.y;
  const sx = e.sx ?? 1, sy = e.sy ?? 1, dx = e.dx ?? 0, dy = e.dy ?? 0;
  return mul(mul([1, 0, 0, 1, -ax, -ay], [sx, 0, 0, sy, 0, 0]), [1, 0, 0, 1, ax + dx, ay - dy]);
}

/** A show command that draws nothing but moves the text cursor by the same amount. */
function blankFor(r: Run, raw: string): string {
  const k = r.size * (r.Tz / 100);
  const adv = k ? `[${fmtNum((-r.advance * 1000) / k)}] TJ` : '';
  if (r.kind === "'") return `T* ${adv}`;
  if (r.kind === '"') {
    const m = raw.match(/^\s*(\S+)\s+(\S+)/);
    return `${m ? `${m[1]} Tw ${m[2]} Tc ` : ''}T* ${adv}`;
  }
  return adv;
}

const textState = (r: Run, tw = r.Tw) =>
  `${fmtOperand({ t: 'name', v: r.fontKey })} ${fmtNum(r.size)} Tf ${fmtNum(r.Tc)} Tc ${fmtNum(tw)} Tw ${fmtNum(r.Tz)} Tz ${fmtNum(r.TL)} TL ${fmtNum(r.Ts)} Ts ${fmtNum(r.Tr)} Tr`;

export async function rewriteContent(an: PageAnalysis, edits: ObjEdits, hooks: RewriteHooks): Promise<{ bytes: Uint8Array; extra: ExtraText[] }> {
  const replace = new Map<number, string>();
  const tail: string[] = [];
  const extra: ExtraText[] = [];
  for (const o of an.objects) {
    const e = edits[o.id];
    if (!isEdited(e)) continue;
    // 1. Remove from the old place.
    if (o.kind === 'text') for (const r of o.runs!) replace.set(r.op, blankFor(r, new TextDecoder('latin1').decode(an.data.subarray(an.ops[r.op].start, an.ops[r.op].end))));
    else for (const i of o.ops) replace.set(i, '');
    if (e.hidden) continue;
    const E = fmtM(editMatrix(an, o, e));
    // 2. Re-draw.
    if (o.kind === 'text') {
      if (e.text == null) {
        for (const r of o.runs!) tail.push(`q ${E} cm ${r.stateRaw} ${fmtM(r.ctm)} cm BT ${textState(r)} ${fmtM(r.tm)} Tm ${r.showRaw.trim()} ET Q`);
        continue;
      }
      const text = e.text;
      if (!text.trim()) continue;
      const r = o.runs![0];
      // Arabic-script text needs shaping, which an existing font's glyph map cannot give: use the Urdu writer.
      const codes = r.font && !ARABIC.test(text) ? r.font.encode(text) : null;
      if (ARABIC.test(text)) {
        extra.push({ x: o.bbox.x + (e.dx ?? 0), y: o.baseline!.y + (e.dy ?? 0), w: o.bbox.w, size: o.size!, color: o.color!, text, bold: !!r.font?.bold });
      } else if (codes) {
        tail.push(`q ${E} cm ${r.stateRaw} ${fmtM(r.ctm)} cm BT ${textState(r)} ${fmtM(r.tm)} Tm <${hexOf(bytesOfCodes(codes, r.font!))}> Tj ET Q`);
      } else {
        const fb = await hooks.fallbackFont(r.font);
        tail.push(`q ${E} cm ${r.stateRaw} ${fmtM(r.ctm)} cm BT ${fmtOperand({ t: 'name', v: fb.key })} ${fmtNum(r.size)} Tf ${fmtNum(r.Tc)} Tc ${fmtNum(r.Tw)} Tw ${fmtNum(r.Tz)} Tz ${fmtNum(r.Ts)} Ts ${fmtNum(r.Tr)} Tr ${fmtM(r.tm)} Tm <${fb.encode(text)}> Tj ET Q`);
      }
    } else {
      tail.push(`q ${E} cm ${o.stateRaw} ${fmtM(o.ctm!)} cm\n${o.raw}\nQ`);
    }
  }
  // Assemble: untouched bytes copied as they are.
  const enc = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0) & 255);
  const parts: Uint8Array[] = [enc('q\n')];
  let pos = 0;
  an.ops.forEach((op, i) => {
    if (!replace.has(i)) return;
    parts.push(an.data.subarray(pos, op.start), enc(replace.get(i)!));
    pos = op.end;
  });
  parts.push(an.data.subarray(pos), enc('\nQ\n' + tail.join('\n') + '\n'));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { bytes.set(p, off); off += p.length; }
  return { bytes, extra };
}

/** Width of replacement text along the baseline, in page points (for the editor's selection box). */
export function replacementWidth(o: PageObj, text: string, stdWidth: (f: FontInfo | null, text: string) => number): number {
  const r = o.runs![0];
  const M = mul(r.tm, r.ctm), scale = Math.hypot(M[0], M[1]);
  const codes = r.font && !ARABIC.test(text) ? r.font.encode(text) : null;
  const Th = r.Tz / 100;
  if (codes && r.font) {
    let tx = 0;
    for (const c of codes) tx += (r.font.widthOf(c) * r.font.type3Scale * r.size + r.Tc + (c === 32 && r.font.bytesPerCode === 1 ? r.Tw : 0)) * Th;
    return tx * scale;
  }
  return stdWidth(r.font, text) * r.size * Th * scale / 1000;
}
export { apply };
