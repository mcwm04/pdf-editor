// Fonts already used inside the opened PDFs, so the Text tool can offer them by name.
// Reads only the pages' resource dictionaries (fast: page content is not parsed).
// New text is still written with the closest built-in font (Helvetica/Times/Courier), because
// fonts inside a PDF are usually subsets that hold only the letters the document used.
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { readFont, deref } from './content/fontinfo';
import type { FontName, PageRef } from './model';

export interface DocFont {
  family: string;      // e.g. "Arial", "Times New Roman"
  std: FontName;       // built-in font used to draw it
  bold: boolean;       // true only if every variant found is bold
  italic: boolean;     // true only if every variant found is italic
}

const STYLE_WORDS = /[-,_ ]?(bold|italic|oblique|regular|roman|book|medium|semibold|demibold|demi|black|heavy|light|thin|condensed|narrow|it|bd|bi|ob|mt|ps|std|pro)\b/gi;

/** "ABCDEF+Arial-BoldMT" -> "Arial"; "TimesNewRomanPS-ItalicMT" -> "Times New Roman". */
export function familyOf(baseFont: string): string {
  let n = baseFont.replace(/^[A-Z]{6}\+/, '').replace(/PS(?=-|,|$)/g, '');
  n = n.split(/[-,]/)[0];                       // drop style after the first - or ,
  n = n.replace(STYLE_WORDS, '').replace(/(MT|PS)$/, '');
  n = n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return n || baseFont;
}

/** Closest built-in font for a detected font. */
function stdFor(f: { serif: boolean; mono: boolean }): FontName {
  return f.mono ? 'Courier' : f.serif ? 'Times' : 'Helvetica';
}

/** Distinct font families used by a PDF (empty when the file cannot be read, e.g. encrypted). */
export async function detectFonts(bytes: Uint8Array): Promise<DocFont[]> {
  const found = new Map<string, { std: FontName; bold: boolean; italic: boolean; n: number }>();
  let doc: PDFDocument;
  try { doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false }); } catch { return []; }
  const ctx = doc.context;
  const seenRes = new Set<PDFDict>();

  const scan = (res: PDFDict | undefined, depth: number) => {
    if (!res || seenRes.has(res)) return;
    seenRes.add(res);
    const fonts = deref(ctx, res.get(PDFName.of('Font')));
    if (fonts instanceof PDFDict) {
      for (const [key] of fonts.entries()) {
        try {
          const d = deref(ctx, fonts.get(key));
          if (!(d instanceof PDFDict)) continue;
          const f = readFont(ctx, key.decodeText(), d);
          if (/^(Symbol|ZapfDingbats)$/i.test(f.baseFont)) continue;
          const family = familyOf(f.baseFont);
          const cur = found.get(family);
          if (cur) { cur.bold &&= f.bold; cur.italic &&= f.italic; cur.n++; }
          else found.set(family, { std: stdFor(f), bold: f.bold, italic: f.italic, n: 1 });
        } catch { /* skip a font we cannot read */ }
      }
    }
    if (depth < 2) { // fonts used inside form XObjects
      const xo = deref(ctx, res.get(PDFName.of('XObject')));
      if (xo instanceof PDFDict) {
        for (const [key] of xo.entries()) {
          const x: any = deref(ctx, xo.get(key));
          const r = x?.dict ? deref(ctx, x.dict.get(PDFName.of('Resources'))) : null;
          if (r instanceof PDFDict) scan(r, depth + 1);
        }
      }
    }
  };

  for (const page of doc.getPages()) {
    try { scan(page.node.Resources(), 0); } catch { /* ignore a broken page */ }
  }
  return [...found.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .map(([family, v]) => ({ family, std: v.std, bold: v.bold, italic: v.italic }));
}

/** Fonts of every open source that still has pages in the document, merged by family name. */
export function documentFonts(pages: PageRef[], fontsBySource: Map<string, DocFont[]>): DocFont[] {
  const out = new Map<string, DocFont>();
  const ids = new Set(pages.map(p => p.sourceId).filter((x): x is string => !!x));
  for (const id of ids) for (const f of fontsBySource.get(id) || []) if (!out.has(f.family)) out.set(f.family, f);
  return [...out.values()];
}
