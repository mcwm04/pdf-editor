// What the editor needs to know about a font already inside a PDF: glyph widths, how to turn
// character codes into Unicode (to show the line in the editor), and whether new text can be
// written back with the same font (every character must exist in it).
import { PDFDict, PDFName, PDFArray, PDFNumber, PDFRef, PDFRawStream, PDFStream, PDFContext, decodePDFRawStream, PDFString, PDFHexString } from 'pdf-lib';
import { Encodings, Font as StdFont } from '@pdf-lib/standard-fonts';

export const deref = (ctx: PDFContext, o: any) => (o instanceof PDFRef ? ctx.lookup(o) : o);
export const asNum = (o: any, d = 0) => (o instanceof PDFNumber ? o.asNumber() : d);
export const asName = (o: any) => (o instanceof PDFName ? o.decodeText() : '');
export function streamBytes(s: any): Uint8Array {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (s instanceof PDFStream) return (s as any).getUnencodedContents ? (s as any).getUnencodedContents() : (s as any).getContents();
  return new Uint8Array();
}

// WinAnsi tables from pdf-lib's standard-fonts package.
const winCodeToUni: (number | null)[] = Array(256).fill(null);
const glyphNameToUni = new Map<string, number>();
for (const cp of Encodings.WinAnsi.supportedCodePoints) {
  const { code, name } = Encodings.WinAnsi.encodeUnicodeCodePoint(cp);
  if (winCodeToUni[code] == null) winCodeToUni[code] = cp;
  glyphNameToUni.set(name, cp);
}
function glyphToUnicode(name: string): number | null {
  if (glyphNameToUni.has(name)) return glyphNameToUni.get(name)!;
  let m = name.match(/^uni([0-9A-Fa-f]{4})/); if (m) return parseInt(m[1], 16);
  m = name.match(/^u([0-9A-Fa-f]{4,6})$/); if (m) return parseInt(m[1], 16);
  if (/^[A-Za-z]$/.test(name)) return name.charCodeAt(0);
  const base = name.split('.')[0]; // e.g. "a.sc"
  return base !== name ? glyphToUnicode(base) : null;
}

const STD: [RegExp, string][] = [
  [/Courier.*Bold.*(Oblique|Italic)/i, 'Courier-BoldOblique'], [/Courier.*Bold/i, 'Courier-Bold'], [/Courier.*(Oblique|Italic)/i, 'Courier-Oblique'], [/Courier/i, 'Courier'],
  [/(Times|Serif).*Bold.*Italic/i, 'Times-BoldItalic'], [/(Times|Serif).*Bold/i, 'Times-Bold'], [/(Times|Serif).*Italic/i, 'Times-Italic'], [/(Times|Serif)/i, 'Times-Roman'],
  [/Bold.*(Oblique|Italic)/i, 'Helvetica-BoldOblique'], [/Bold/i, 'Helvetica-Bold'], [/(Oblique|Italic)/i, 'Helvetica-Oblique'],
  [/Symbol/i, 'Symbol'], [/Dingbats/i, 'ZapfDingbats'], [/./, 'Helvetica'],
];
const stdName = (base: string) => STD.find(([re]) => re.test(base))![1];
const stdCache = new Map<string, StdFont>();
const stdFont = (n: string) => { if (!stdCache.has(n)) stdCache.set(n, StdFont.load(n as any)); return stdCache.get(n)!; };

export interface FontInfo {
  key: string;            // resource name, e.g. F1
  baseFont: string;       // without subset prefix
  composite: boolean;     // Type0: 2-byte codes
  bytesPerCode: 1 | 2;
  subset: boolean;
  type3Scale: number;     // glyph units -> text space (0.001 for normal fonts)
  ascent: number; descent: number; // in 1/1000 em
  bold: boolean; italic: boolean; serif: boolean; mono: boolean;
  widthOf(code: number): number;            // glyph units (1/1000 em for non-Type3)
  toUnicode(code: number): string | null;
  /** Codes for `text`, or null if the font cannot show every character. */
  encode(text: string): number[] | null;
}

function parseCMap(text: string) {
  const map = new Map<number, string>();
  let codeLen = 1;
  const cs = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (cs) { const m = /<([0-9a-fA-F]+)>/.exec(cs[1]); if (m) codeLen = m[1].length / 2; }
  const hexToStr = (h: string) => { let s = ''; for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); if (h.length === 2) s = String.fromCharCode(parseInt(h, 16)); return s; };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), hexToStr(m[2]));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (hi - lo > 65535) continue;
      if (m[3].startsWith('[')) {
        const items = [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map(x => hexToStr(x[1]));
        items.forEach((s, k) => map.set(lo + k, s));
      } else {
        const h = m[3].slice(1, -1);
        const first = hexToStr(h);
        for (let c = lo; c <= hi; c++) {
          const last = first.charCodeAt(first.length - 1) + (c - lo);
          map.set(c, first.slice(0, -1) + String.fromCharCode(last));
        }
      }
    }
  }
  return { map, codeLen };
}

export function readFont(ctx: PDFContext, key: string, dict: PDFDict): FontInfo {
  const subtype = asName(dict.get(PDFName.of('Subtype')));
  const rawBase = asName(dict.get(PDFName.of('BaseFont'))) || asName(dict.get(PDFName.of('Name'))) || key;
  const subset = /^[A-Z]{6}\+/.test(rawBase);
  const baseFont = rawBase.replace(/^[A-Z]{6}\+/, '');
  const composite = subtype === 'Type0';
  let descDict: PDFDict | undefined;
  let widthOf: (c: number) => number;

  // ToUnicode
  let cmap: Map<number, string> | null = null;
  const tu = deref(ctx, dict.get(PDFName.of('ToUnicode')));
  if (tu instanceof PDFStream) {
    try { cmap = parseCMap(new TextDecoder('latin1').decode(streamBytes(tu))).map; } catch { cmap = null; }
  }

  let type3Scale = 0.001;
  let simpleUni: (number | null)[] | null = null;
  let flags = 0;
  if (composite) {
    const desc = deref(ctx, (deref(ctx, dict.get(PDFName.of('DescendantFonts'))) as PDFArray)?.get(0)) as PDFDict;
    const dw = asNum(desc?.get(PDFName.of('DW')), 1000);
    const widths = new Map<number, number>();
    const W = deref(ctx, desc?.get(PDFName.of('W')));
    if (W instanceof PDFArray) {
      const arr = W.asArray().map(o => deref(ctx, o));
      for (let i = 0; i < arr.length;) {
        const first = asNum(arr[i]);
        if (arr[i + 1] instanceof PDFArray) {
          (arr[i + 1] as PDFArray).asArray().forEach((w, k) => widths.set(first + k, asNum(deref(ctx, w))));
          i += 2;
        } else { const last = asNum(arr[i + 1]), w = asNum(arr[i + 2]); for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, w); i += 3; }
      }
    }
    widthOf = c => widths.get(c) ?? dw;
    descDict = deref(ctx, desc?.get(PDFName.of('FontDescriptor')));
  } else {
    const first = asNum(dict.get(PDFName.of('FirstChar')), 0);
    const W = deref(ctx, dict.get(PDFName.of('Widths')));
    descDict = deref(ctx, dict.get(PDFName.of('FontDescriptor')));
    const missing = asNum(descDict?.get(PDFName.of('MissingWidth')), 0);
    if (subtype === 'Type3') {
      const fm = deref(ctx, dict.get(PDFName.of('FontMatrix')));
      if (fm instanceof PDFArray) type3Scale = asNum(deref(ctx, fm.get(0)), 0.001);
    }
    // Encoding: base table + Differences.
    simpleUni = winCodeToUni.slice();
    const enc = deref(ctx, dict.get(PDFName.of('Encoding')));
    if (enc instanceof PDFDict) {
      const diffs = deref(ctx, enc.get(PDFName.of('Differences')));
      if (diffs instanceof PDFArray) {
        let code = 0;
        for (const o of diffs.asArray().map(x => deref(ctx, x))) {
          if (o instanceof PDFNumber) code = o.asNumber();
          else if (o instanceof PDFName) { simpleUni[code] = glyphToUnicode(o.decodeText()); code++; }
        }
      }
    }
    if (W instanceof PDFArray) {
      const arr = W.asArray().map(o => asNum(deref(ctx, o)));
      widthOf = c => (c >= first && c < first + arr.length ? arr[c - first] : missing);
    } else {
      // Standard 14 font without a width table.
      const std = stdFont(stdName(baseFont));
      widthOf = c => {
        const u = simpleUni![c];
        if (u == null) return missing || 500;
        const name = Encodings.WinAnsi.canEncodeUnicodeCodePoint(u) ? Encodings.WinAnsi.encodeUnicodeCodePoint(u).name : '';
        return (name && (std.getWidthOfGlyph(name) as number)) || missing || 500;
      };
    }
  }
  flags = asNum(descDict?.get(PDFName.of('Flags')), 0);
  const ascent = asNum(descDict?.get(PDFName.of('Ascent')), 750) || 750;
  const descent = asNum(descDict?.get(PDFName.of('Descent')), -250) || -250;

  const toUnicode = (code: number): string | null => {
    if (cmap && cmap.has(code)) return cmap.get(code)!;
    if (!composite && simpleUni) { const u = simpleUni[code]; return u == null ? null : String.fromCodePoint(u); }
    return null;
  };

  // Reverse map: only characters this font really contains.
  const reverse = new Map<string, number>();
  if (cmap) for (const [code, s] of cmap) { if (s && !reverse.has(s)) reverse.set(s, code); }
  if (!composite && simpleUni) {
    simpleUni.forEach((u, code) => {
      if (u == null) return;
      const ch = String.fromCodePoint(u);
      if (reverse.has(ch)) return;
      // A subset font only has the glyphs it used: trust a code only if it has a width.
      if (subset && !(widthOf(code) > 0)) return;
      if (cmap && subset) return; // subset fonts with a ToUnicode map list every glyph they contain
      reverse.set(ch, code);
    });
  }
  const encode = (text: string): number[] | null => {
    const out: number[] = [];
    for (const ch of text) {
      const c = reverse.get(ch);
      if (c == null) return null;
      out.push(c);
    }
    return out;
  };

  const lname = baseFont.toLowerCase();
  return {
    key, baseFont, composite, bytesPerCode: composite ? 2 : 1, subset, type3Scale, ascent, descent,
    bold: /bold|black|heavy|semibold|demi/.test(lname) || (flags & 0x40000) !== 0,
    italic: /italic|oblique/.test(lname) || (flags & 0x40) !== 0,
    serif: /times|serif|georgia|garamond|cambria|book|roman/.test(lname.replace('sans', '')) || ((flags & 2) !== 0 && !/sans|arial|helvetica/.test(lname)),
    mono: /courier|mono|consol/.test(lname) || (flags & 1) !== 0,
    widthOf, toUnicode, encode,
  };
}

/** Split a string operand into character codes. */
export function codesOf(bytes: Uint8Array, f: FontInfo): number[] {
  if (f.bytesPerCode === 1) return Array.from(bytes);
  const out: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) out.push((bytes[i] << 8) | bytes[i + 1]);
  return out;
}
export function bytesOfCodes(codes: number[], f: FontInfo): Uint8Array {
  if (f.bytesPerCode === 1) return Uint8Array.from(codes);
  const out = new Uint8Array(codes.length * 2);
  codes.forEach((c, i) => { out[2 * i] = c >> 8; out[2 * i + 1] = c & 255; });
  return out;
}
export { PDFString, PDFHexString };
