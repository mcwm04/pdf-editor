// Urdu (and any right-to-left / complex-script) text in the PDF.
// HarfBuzz shapes the text exactly as the browser does (Nastaliq needs this), bidi-js orders mixed
// Urdu/English runs, and the font is embedded as a CID font so the text stays real, selectable text.
// If WebAssembly is blocked (some sandboxed hosts), the text is drawn as a high-resolution image instead.
import {
  PDFDocument, PDFPage, PDFFont, PDFRef, PDFDict, PDFName, PDFString, PDFHexString, PDFOperator, PDFOperatorNames,
  StandardFonts, rgb, beginText, endText, setFontAndSize, setTextMatrix, showText, setFillingRgbColor,
  pushGraphicsState, popGraphicsState, endMarkedContent,
} from 'pdf-lib';
import bidiFactory from 'bidi-js';
import * as hbjs from 'harfbuzzjs';
import wasmData from 'harfbuzzjs/dist/harfbuzz.wasm?base64';
import type { TextAnn, FontName } from './model';
import { METRICS, FONT_CSS, UrduFont, isRtlText, urduFontBytes, URDU_PS_NAME, URDU_BBOX } from './fonts';

type HB = typeof hbjs;
let hbReady: Promise<HB | null> | null = null;
/** Load HarfBuzz once. Resolves null when WebAssembly is not allowed here. */
export function getHarfBuzz(): Promise<HB | null> {
  return hbReady ||= (async () => {
    try {
      const bin = Uint8Array.from(atob(wasmData), c => c.charCodeAt(0));
      await (hbjs as any).__hbInit({ wasmBinary: bin });
      return hbjs;
    } catch (e) { console.warn('HarfBuzz unavailable, Urdu text will be saved as images', e); return null; }
  })();
}

const bidi = bidiFactory();

interface FontSet {
  key: string; hbFont: any; upem: number; cmap: Set<number>;
  type0: PDFRef; cid: PDFDict; tagByPage: WeakMap<PDFPage, PDFName>;
  used: Map<number, { w: number; text: string | null }>;
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0').toUpperCase();
const utf16Hex = (s: string) => Array.from(s, ch => { const cp = ch.codePointAt(0)!; if (cp < 0x10000) return hex4(cp); const v = cp - 0x10000; return hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff)); }).join('');

/** One per exported document: embeds each Urdu font once and finalises widths + ToUnicode maps on save. */
export class UnicodeTextWriter {
  private sets = new Map<string, FontSet>();
  private latin = new Map<string, PDFFont>();
  rasterised = false;
  constructor(private out: PDFDocument, private hb: HB | null) {}

  private fontSet(font: UrduFont, bold: boolean): FontSet {
    const key = `${font}-${bold}`;
    let set = this.sets.get(key);
    if (set) return set;
    const hb = this.hb!, ctx = this.out.context, bytes = urduFontBytes(font, bold);
    const face = new hb.Face(new hb.Blob(bytes));
    const hbFont = new hb.Font(face);
    const upem = face.upem, k = 1000 / upem, ps = URDU_PS_NAME[key], bbox = URDU_BBOX[key].map(v => Math.round(v * k));
    const fileRef = ctx.register(ctx.flateStream(bytes, { Length1: bytes.length }));
    const descRef = ctx.register(ctx.obj({
      Type: 'FontDescriptor', FontName: ps, Flags: 4, FontBBox: bbox, ItalicAngle: 0,
      Ascent: bbox[3], Descent: bbox[1], CapHeight: Math.round(bbox[3] * 0.7), StemV: 80, FontFile2: fileRef,
    }));
    const cid = ctx.obj({
      Type: 'Font', Subtype: 'CIDFontType2', BaseFont: ps, FontDescriptor: descRef, CIDToGIDMap: 'Identity', DW: 1000,
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
    }) as PDFDict;
    const cidRef = ctx.register(cid);
    const type0 = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: ps, Encoding: 'Identity-H', DescendantFonts: [cidRef] }));
    set = { key, hbFont, upem, cmap: new Set(face.collectUnicodes()), type0, cid, tagByPage: new WeakMap(), used: new Map() };
    this.sets.set(key, set);
    return set;
  }

  private async latinFont(bold: boolean) {
    const name = bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica;
    if (!this.latin.has(name)) this.latin.set(name, await this.out.embedFont(name));
    return this.latin.get(name)!;
  }

  /** Draw a text annotation whose (effective) font is an Urdu font. Coordinates: top-left page space. */
  async draw(page: PDFPage, a: TextAnn, font: UrduFont, ox: number, top: number, color: [number, number, number]) {
    if (!this.hb) return this.drawAsImage(page, a, font, ox, top);
    const set = this.fontSet(font, a.bold);
    const latin = await this.latinFont(a.bold);
    const allowed = new Set(latin.getCharacterSet());
    const m = METRICS[font], s = a.size, k = s / set.upem, rtl = isRtlText(a.text);
    let tag = set.tagByPage.get(page);
    if (!tag) { tag = page.node.newFontDictionary('Urdu', set.type0); set.tagByPage.set(page, tag); }
    const ops: PDFOperator[] = [pushGraphicsState()];
    a.text.split('\n').forEach((line, li) => {
      if (!line) return;
      const baseY = a.y + s * (m.base + m.lh * li);
      const runs = this.layoutLine(line, rtl, set, latin, allowed, s);
      const width = runs.reduce((w, r) => w + r.width, 0);
      let x = rtl ? a.x + a.w - width : a.x;
      for (const r of runs) {
        if (r.kind === 'latin') {
          page.drawText(r.text, { x: ox + x, y: top - baseY, size: s, font: latin, color: rgb(...color) });
        } else {
          ops.push(beginText(), setFontAndSize(tag!, s), setFillingRgbColor(...color));
          ops.push(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
            PDFName.of('Span'), this.out.context.obj({ ActualText: PDFHexString.of('FEFF' + utf16Hex(r.text)) }) as any]));
          for (const g of r.glyphs) {
            ops.push(setTextMatrix(1, 0, 0, 1, ox + x + g.x * k, top - baseY + g.y * k), showText(PDFHexString.of(hex4(g.gid))));
          }
          ops.push(endMarkedContent(), endText());
        }
        x += r.width;
      }
    });
    ops.push(popGraphicsState());
    page.pushOperators(...ops);
  }

  /** Split one line into visual runs (bidi), shape the Urdu runs with HarfBuzz. */
  private layoutLine(line: string, rtl: boolean, set: FontSet, latin: PDFFont, allowed: Set<number>, size: number) {
    const hb = this.hb!;
    const levels = bidi.getEmbeddingLevels(line, rtl ? 'rtl' : 'ltr');
    const order = Array.from({ length: line.length }, (_, i) => i);
    for (const [st, en] of bidi.getReorderSegments(line, levels)) {
      for (let i = st, j = en; i < j; i++, j--) [order[i], order[j]] = [order[j], order[i]];
    }
    const cls = (i: number) => {
      const c = line.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdfff) return 'urdu';
      return set.cmap.has(c) ? 'urdu' : 'latin';
    };
    // Group visually consecutive characters that share direction and font and are logically contiguous.
    const groups: { start: number; end: number; level: number; kind: 'urdu' | 'latin' }[] = [];
    for (const i of order) {
      const g = groups[groups.length - 1], lv = levels.levels[i], kind = cls(i);
      const rtlRun = lv % 2 === 1;
      if (g && g.level === lv && g.kind === kind && (rtlRun ? i === g.start - 1 : i === g.end)) {
        if (rtlRun) g.start = i; else g.end = i + 1;
      } else groups.push({ start: i, end: i + 1, level: lv, kind });
    }
    type Glyph = { gid: number; x: number; y: number };
    const runs: ({ kind: 'latin'; text: string; width: number } | { kind: 'urdu'; text: string; width: number; glyphs: Glyph[] })[] = [];
    const k = size / set.upem;
    for (const g of groups) {
      const text = line.slice(g.start, g.end);
      if (g.kind === 'latin') {
        let t = Array.from(text, ch => allowed.has(ch.codePointAt(0)!) ? ch : '?').join('');
        if (g.level % 2 === 1) t = Array.from(t).reverse().join('');
        runs.push({ kind: 'latin', text: t, width: latin.widthOfTextAtSize(t, size) });
        continue;
      }
      const buf = new hb.Buffer();
      buf.addText(line, g.start, g.end - g.start);
      buf.setDirection(g.level % 2 === 1 ? hb.Direction.RTL : hb.Direction.LTR);
      buf.setScript('Arab'); buf.setLanguage('ur');
      hb.shape(set.hbFont, buf);
      const infos = buf.getGlyphInfos(), pos = buf.getGlyphPositions();
      const clusters = [...new Set(infos.map((i: any) => i.cluster as number))].sort((p, q) => p - q);
      const nextCluster = (c: number) => clusters.find(v => v > c) ?? g.end;
      const seenCluster = new Set<number>();
      // Map each cluster's text to its first glyph in logical order (RTL output is reversed).
      const logical = g.level % 2 === 1 ? [...infos.keys()].reverse() : [...infos.keys()];
      const textFor = new Map<number, string>();
      for (const idx of logical) { const c = infos[idx].cluster; if (!seenCluster.has(c)) { seenCluster.add(c); textFor.set(idx, line.slice(c, nextCluster(c))); } }
      let pen = 0; const glyphs: Glyph[] = [];
      infos.forEach((info: any, idx: number) => {
        const p = pos[idx];
        glyphs.push({ gid: info.codepoint, x: pen + p.xOffset, y: p.yOffset });
        const prev = set.used.get(info.codepoint);
        const t = textFor.get(idx) ?? null;
        if (!prev) set.used.set(info.codepoint, { w: Math.round(set.hbFont.glyphHAdvance(info.codepoint) * 1000 / set.upem), text: t });
        else if (!prev.text && t) prev.text = t;
        pen += p.xAdvance;
      });
      runs.push({ kind: 'urdu', text, width: pen * k, glyphs });
    }
    return runs;
  }

  /** Fallback without HarfBuzz: let the browser shape the text and embed it as a 4x PNG. */
  private async drawAsImage(page: PDFPage, a: TextAnn, font: FontName, ox: number, top: number) {
    this.rasterised = true;
    const m = METRICS[font], s = a.size, scale = 4, pad = s * 1.2, rtl = isRtlText(a.text);
    const lines = a.text.split('\n');
    const W = a.w + pad * 2, H = lines.length * s * m.lh + pad * 2;
    const c = document.createElement('canvas'); c.width = Math.ceil(W * scale); c.height = Math.ceil(H * scale);
    const g = c.getContext('2d')!;
    g.scale(scale, scale);
    g.font = `${a.bold ? 'bold ' : ''}${s}px ${FONT_CSS[font]}`;
    g.fillStyle = a.color; g.direction = rtl ? 'rtl' : 'ltr'; g.textAlign = rtl ? 'right' : 'left';
    lines.forEach((l, i) => g.fillText(l, rtl ? pad + a.w : pad, pad + s * (m.base + m.lh * i)));
    const png = await new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/png'));
    const img = await this.out.embedPng(new Uint8Array(await png.arrayBuffer()));
    page.drawImage(img, { x: ox + a.x - pad, y: top - (a.y - pad) - H, width: W, height: H });
  }

  /** Write the width table and the ToUnicode map (copy/search) for every Urdu font used. */
  finish() {
    const ctx = this.out.context;
    for (const set of this.sets.values()) {
      const gids = [...set.used.keys()].sort((p, q) => p - q);
      const W: any[] = [];
      for (const gid of gids) W.push(gid, [set.used.get(gid)!.w]);
      set.cid.set(PDFName.of('W'), ctx.obj(W));
      const entries = gids.filter(gid => set.used.get(gid)!.text).map(gid => `<${hex4(gid)}> <${utf16Hex(set.used.get(gid)!.text!)}>`);
      let body = '';
      for (let i = 0; i < entries.length; i += 100) {
        const chunk = entries.slice(i, i + 100);
        body += `${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar\n`;
      }
      const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${body}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
      const type0 = ctx.lookup(set.type0) as PDFDict;
      type0.set(PDFName.of('ToUnicode'), ctx.register(ctx.flateStream(cmap)));
    }
  }
}
