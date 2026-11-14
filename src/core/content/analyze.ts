// Replays a page's content stream and lists the objects a person can select: text segments
// (same font, one baseline), images/forms, and painted shapes. Also keeps the drawing state each
// object needs so it can be re-drawn somewhere else.
import { PDFDict, PDFName, PDFArray, PDFContext, PDFStream, PDFPageLeaf } from 'pdf-lib';
import { lex, Op, Operand, fmtNum } from './lexer';
import { FontInfo, readFont, deref, asNum, asName, streamBytes, codesOf } from './fontinfo';

export type M = [number, number, number, number, number, number];
export const I: M = [1, 0, 0, 1, 0, 0];
export const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
export const apply = (m: M, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
export const fmtM = (m: M) => m.map(fmtNum).join(' ');

interface State {
  ctm: M; fillCs: string; fill: string; strokeCs: string; stroke: string; line: Record<string, string>; gs: string[];
  font: string; size: number; Tc: number; Tw: number; Tz: number; TL: number; Ts: number; Tr: number; rgb: [number, number, number];
}

export interface Run {
  op: number; kind: string; fontKey: string; font: FontInfo | null; size: number;
  tm: M; ctm: M; Tc: number; Tw: number; Tz: number; TL: number; Ts: number; Tr: number;
  advance: number; start: [number, number]; end: [number, number]; text: string;
  stateRaw: string; showRaw: string; args: Operand[];
}

export interface Box { x: number; y: number; w: number; h: number }
export interface PageObj {
  id: string; kind: 'text' | 'image' | 'shape'; ops: number[]; bbox: Box; // top-left page coords (points)
  runs?: Run[]; text?: string; size?: number; color?: string; angle?: number; font?: FontInfo | null;
  baseline?: { x: number; y: number };   // start of the baseline, top-left coords
  raw?: string;                           // re-draw commands (images/shapes), without matrix
  stateRaw?: string; ctm?: M; label?: string; fullPage?: boolean;
}

export interface PageAnalysis { data: Uint8Array; ops: Op[]; objects: PageObj[]; ox: number; top: number; width: number; height: number }

const PATH_CONS = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
const num = (o: Operand | undefined) => (o && o.t === 'num' ? o.v : 0);
const hex2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
export const rgbHex = (c: [number, number, number]) => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;
const cmyk = (c: number, m: number, y: number, k: number): [number, number, number] => [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];

export function pageContentBytes(ctx: PDFContext, node: PDFPageLeaf): Uint8Array {
  const contents = deref(ctx, node.get(PDFName.of('Contents')));
  const parts: Uint8Array[] = [];
  if (contents instanceof PDFArray) for (const r of contents.asArray()) parts.push(streamBytes(deref(ctx, r)));
  else if (contents instanceof PDFStream) parts.push(streamBytes(contents));
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 10; }
  return out;
}

export function analyze(ctx: PDFContext, node: PDFPageLeaf, crop: Box): PageAnalysis {
  const data = pageContentBytes(ctx, node);
  const ops = lex(data);
  const resources = deref(ctx, node.getInheritableAttribute(PDFName.of('Resources'))) as PDFDict | undefined;
  const fontDict = deref(ctx, resources?.get(PDFName.of('Font'))) as PDFDict | undefined;
  const xobjDict = deref(ctx, resources?.get(PDFName.of('XObject'))) as PDFDict | undefined;
  const fonts = new Map<string, FontInfo | null>();
  const getFont = (key: string) => {
    if (!fonts.has(key)) {
      let f: FontInfo | null = null;
      try { const d = deref(ctx, fontDict?.get(PDFName.of(key))); if (d instanceof PDFDict) f = readFont(ctx, key, d); } catch (e) { console.warn('font', key, e); }
      fonts.set(key, f);
    }
    return fonts.get(key)!;
  };
  const ox = crop.x, top = crop.y + crop.h;
  const toTL = (x: number, y: number) => ({ x: x - ox, y: top - y });
  const boxOf = (pts: [number, number][]): Box => {
    const xs = pts.map(p => p[0] - ox), ys = pts.map(p => top - p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
  };
  const raw = (op: Op) => new TextDecoder('latin1').decode(data.subarray(op.start, op.end));

  let st: State = {
    ctm: I, fillCs: '', fill: '', strokeCs: '', stroke: '', line: {}, gs: [],
    font: '', size: 0, Tc: 0, Tw: 0, Tz: 100, TL: 0, Ts: 0, Tr: 0, rgb: [0, 0, 0],
  };
  const stack: State[] = [];
  let Tm: M = I, Tlm: M = I;
  const runs: Run[] = [];
  const objects: PageObj[] = [];
  let pathStart = -1, pathPts: [number, number][] = [], clip = false;

  const stateRaw = () => [...st.gs, st.strokeCs, st.stroke, st.fillCs, st.fill, ...Object.values(st.line)].filter(Boolean).join(' ');

  const show = (idx: number, kind: string, items: Operand[], showRaw: string) => {
    const f = getFont(st.font);
    const Th = st.Tz / 100, Tfs = st.size;
    let tx = 0, text = '';
    for (const it of items) {
      if (it.t === 'num') {
        tx += (-it.v / 1000) * Tfs * Th;
        if (it.v < -250 && text && !text.endsWith(' ')) text += ' ';
      } else if (it.t === 'str') {
        const codes = f ? codesOf(it.v, f) : Array.from(it.v);
        for (const code of codes) {
          const w = f ? f.widthOf(code) * (f.type3Scale) : 0.5;
          tx += (w * Tfs + st.Tc + (code === 32 && (!f || f.bytesPerCode === 1) ? st.Tw : 0)) * Th;
          const u = f?.toUnicode(code);
          text += u ?? (f ? '�' : String.fromCharCode(code));
        }
      }
    }
    const M = mul(Tm, st.ctm);
    const asc = ((f?.ascent ?? 750) / 1000) * Tfs + st.Ts, desc = ((f?.descent ?? -250) / 1000) * Tfs + st.Ts;
    const start = apply(M, 0, st.Ts), end = apply(M, tx, st.Ts);
    const corners = [apply(M, 0, desc), apply(M, tx, desc), apply(M, tx, asc), apply(M, 0, asc)];
    if (st.Tr !== 3 && st.Tr !== 7 && Tfs !== 0) {
      runs.push({
        op: idx, kind, fontKey: st.font, font: f, size: Tfs, tm: Tm, ctm: st.ctm, Tc: st.Tc, Tw: st.Tw, Tz: st.Tz, TL: st.TL, Ts: st.Ts, Tr: st.Tr,
        advance: tx, start, end, text, stateRaw: stateRaw(), showRaw, args: items,
        // bbox stored temporarily via corners
        ...({ corners } as any),
      });
    }
    Tm = mul([1, 0, 0, 1, tx, 0], Tm);
  };

  ops.forEach((o, idx) => {
    const a = o.args;
    switch (o.op) {
      case 'q': stack.push({ ...st, line: { ...st.line }, gs: [...st.gs] }); break;
      case 'Q': if (stack.length) st = stack.pop()!; break;
      case 'cm': st.ctm = mul(a.map(num) as M, st.ctm); break;
      case 'w': case 'J': case 'j': case 'M': case 'd': case 'ri': st.line[o.op] = raw(o).trim(); break;
      case 'gs': st.gs.push(raw(o).trim()); break;
      case 'g': st.fillCs = ''; st.fill = raw(o).trim(); st.rgb = [num(a[0]), num(a[0]), num(a[0])]; break;
      case 'rg': st.fillCs = ''; st.fill = raw(o).trim(); st.rgb = [num(a[0]), num(a[1]), num(a[2])]; break;
      case 'k': st.fillCs = ''; st.fill = raw(o).trim(); st.rgb = cmyk(num(a[0]), num(a[1]), num(a[2]), num(a[3])); break;
      case 'cs': st.fillCs = raw(o).trim(); st.fill = ''; st.rgb = [0, 0, 0]; break;
      case 'sc': case 'scn': {
        st.fill = raw(o).trim();
        const n = a.filter(x => x.t === 'num').map(num);
        if (n.length === 1) st.rgb = [n[0], n[0], n[0]]; else if (n.length === 3) st.rgb = [n[0], n[1], n[2]]; else if (n.length === 4) st.rgb = cmyk(n[0], n[1], n[2], n[3]);
        break;
      }
      case 'G': case 'RG': case 'K': st.strokeCs = ''; st.stroke = raw(o).trim(); break;
      case 'CS': st.strokeCs = raw(o).trim(); st.stroke = ''; break;
      case 'SC': case 'SCN': st.stroke = raw(o).trim(); break;
      // text state
      case 'BT': Tm = I; Tlm = I; break;
      case 'Tf': st.font = a[0]?.t === 'name' ? a[0].v : ''; st.size = num(a[1]); break;
      case 'Tc': st.Tc = num(a[0]); break;
      case 'Tw': st.Tw = num(a[0]); break;
      case 'Tz': st.Tz = num(a[0]); break;
      case 'TL': st.TL = num(a[0]); break;
      case 'Ts': st.Ts = num(a[0]); break;
      case 'Tr': st.Tr = num(a[0]); break;
      case 'Td': Tlm = mul([1, 0, 0, 1, num(a[0]), num(a[1])], Tlm); Tm = Tlm; break;
      case 'TD': st.TL = -num(a[1]); Tlm = mul([1, 0, 0, 1, num(a[0]), num(a[1])], Tlm); Tm = Tlm; break;
      case 'Tm': Tlm = a.map(num) as M; Tm = Tlm; break;
      case 'T*': Tlm = mul([1, 0, 0, 1, 0, -st.TL], Tlm); Tm = Tlm; break;
      case 'Tj': if (a[0]?.t === 'str') show(idx, 'Tj', [a[0]], raw(o).trim()); break;
      case 'TJ': if (a[0]?.t === 'arr') show(idx, 'TJ', a[0].v, raw(o).trim()); break;
      case "'": {
        Tlm = mul([1, 0, 0, 1, 0, -st.TL], Tlm); Tm = Tlm;
        if (a[0]?.t === 'str') show(idx, "'", [a[0]], `<${Array.from(a[0].v, b => b.toString(16).padStart(2, '0')).join('')}> Tj`);
        break;
      }
      case '"': {
        st.Tw = num(a[0]); st.Tc = num(a[1]);
        Tlm = mul([1, 0, 0, 1, 0, -st.TL], Tlm); Tm = Tlm;
        if (a[2]?.t === 'str') show(idx, '"', [a[2]], `<${Array.from(a[2].v, b => b.toString(16).padStart(2, '0')).join('')}> Tj`);
        break;
      }
      // images and forms
      case 'Do': {
        const name = a[0]?.t === 'name' ? a[0].v : '';
        const xo = deref(ctx, xobjDict?.get(PDFName.of(name)));
        if (!(xo instanceof PDFStream)) break;
        const sub = asName(xo.dict.get(PDFName.of('Subtype')));
        let pts: [number, number][];
        if (sub === 'Form') {
          const bb = deref(ctx, xo.dict.get(PDFName.of('BBox'))) as PDFArray | undefined;
          const b = bb ? bb.asArray().map(v => asNum(deref(ctx, v))) : [0, 0, 1, 1];
          const fm = deref(ctx, xo.dict.get(PDFName.of('Matrix'))) as PDFArray | undefined;
          const mm = mul(fm ? (fm.asArray().map(v => asNum(deref(ctx, v))) as M) : I, st.ctm);
          pts = [apply(mm, b[0], b[1]), apply(mm, b[2], b[1]), apply(mm, b[2], b[3]), apply(mm, b[0], b[3])];
        } else if (sub === 'Image') {
          pts = [apply(st.ctm, 0, 0), apply(st.ctm, 1, 0), apply(st.ctm, 1, 1), apply(st.ctm, 0, 1)];
        } else break;
        objects.push({ id: `I${idx}`, kind: 'image', ops: [idx], bbox: boxOf(pts), raw: raw(o).trim(), stateRaw: stateRaw(), ctm: st.ctm, label: sub === 'Form' ? 'Graphic' : 'Image' });
        break;
      }
      case 'BI': {
        const pts: [number, number][] = [apply(st.ctm, 0, 0), apply(st.ctm, 1, 0), apply(st.ctm, 1, 1), apply(st.ctm, 0, 1)];
        objects.push({ id: `I${idx}`, kind: 'image', ops: [idx], bbox: boxOf(pts), raw: raw(o), stateRaw: stateRaw(), ctm: st.ctm, label: 'Image' });
        break;
      }
      // paths
      case 'W': case 'W*': clip = true; break;
      default:
        if (PATH_CONS.has(o.op)) {
          if (pathStart < 0) pathStart = idx;
          const n = a.map(num);
          if (o.op === 're') { const [x, y, w, h] = n; pathPts.push(apply(st.ctm, x, y), apply(st.ctm, x + w, y), apply(st.ctm, x + w, y + h), apply(st.ctm, x, y + h)); }
          else for (let k = 0; k + 1 < n.length; k += 2) pathPts.push(apply(st.ctm, n[k], n[k + 1]));
        } else if (PAINT.has(o.op)) {
          if (pathStart >= 0 && !clip && o.op !== 'n' && pathPts.length) {
            const range = Array.from({ length: idx - pathStart + 1 }, (_, k) => pathStart + k);
            const bbox = boxOf(pathPts);
            const filled = !['S', 's'].includes(o.op);
            const pageArea = crop.w * crop.h;
            objects.push({
              id: `S${pathStart}`, kind: 'shape', ops: range, bbox, label: filled ? 'Shape' : 'Line',
              raw: range.map(r => raw(ops[r]).trim()).join('\n'), stateRaw: stateRaw(), ctm: st.ctm,
              fullPage: filled && bbox.w * bbox.h > pageArea * 0.8,
            });
          }
          pathStart = -1; pathPts = []; clip = false;
        }
    }
  });

  // Group runs into text segments: same font and size, one baseline, close together.
  let cur: Run[] = [];
  const flush = () => {
    if (!cur.length) return;
    const first = cur[0];
    const M0 = mul(first.tm, first.ctm);
    const angle = Math.atan2(M0[1], M0[0]);
    const scaleY = Math.hypot(M0[2], M0[3]);
    const pts = cur.flatMap(r => (r as any).corners as [number, number][]);
    let text = '';
    cur.forEach((r, i) => {
      if (i > 0) {
        const prev = cur[i - 1];
        const gap = Math.hypot(r.start[0] - prev.end[0], r.start[1] - prev.end[1]);
        if (gap > first.size * scaleY * 0.2 && !text.endsWith(' ') && !r.text.startsWith(' ')) text += ' ';
      }
      text += r.text;
    });
    objects.push({
      id: `T${first.op}`, kind: 'text', ops: cur.map(r => r.op), bbox: boxOf(pts), runs: cur, text,
      size: first.size * scaleY, angle, font: first.font, baseline: toTL(...first.start), ctm: first.ctm,
      color: '#000000', label: 'Text',
    });
    cur = [];
  };
  // colour per run: recompute from stateRaw is costly; take it from the run's state at creation
  for (const r of runs) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const Mp = mul(prev.tm, prev.ctm), Mr = mul(r.tm, r.ctm);
      const ang = Math.atan2(Mp[1], Mp[0]), angR = Math.atan2(Mr[1], Mr[0]);
      const u = [Math.cos(ang), Math.sin(ang)], v = [-u[1], u[0]];
      const h = prev.size * Math.hypot(Mp[2], Mp[3]);
      const d = [r.start[0] - prev.end[0], r.start[1] - prev.end[1]];
      const along = d[0] * u[0] + d[1] * u[1], perp = d[0] * v[0] + d[1] * v[1];
      const same = r.fontKey === prev.fontKey && Math.abs(r.size - prev.size) < 0.01 && Math.abs(ang - angR) < 0.02 && r.stateRaw === prev.stateRaw
        && Math.abs(perp) < h * 0.3 && along > -h * 0.5 && along < h * 2;
      if (!same) flush();
    }
    cur.push(r);
  }
  flush();
  // Text colour from the fill state recorded with each run.
  for (const o of objects) if (o.kind === 'text') o.color = colorFromState(o.runs![0].stateRaw);
  return { data, ops, objects, ox, top, width: crop.w, height: crop.h };
}

/** Approximate fill colour (hex) from recorded state commands. */
function colorFromState(s: string): string {
  const toks = s.split(/\s+/);
  let rgb: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const n = (k: number) => parseFloat(toks[i - k]);
    if (t === 'rg') rgb = [n(3), n(2), n(1)];
    else if (t === 'g') rgb = [n(1), n(1), n(1)];
    else if (t === 'k') rgb = cmyk(n(4), n(3), n(2), n(1));
    else if (t === 'sc' || t === 'scn') {
      const vals: number[] = []; for (let k = i - 1; k >= 0 && !isNaN(parseFloat(toks[k])) && vals.length < 4; k--) vals.unshift(parseFloat(toks[k]));
      if (vals.length === 1) rgb = [vals[0], vals[0], vals[0]]; else if (vals.length === 3) rgb = vals as any; else if (vals.length === 4) rgb = cmyk(vals[0], vals[1], vals[2], vals[3]);
    }
  }
  return rgbHex(rgb.map(v => (isNaN(v) ? 0 : v)) as any);
}
