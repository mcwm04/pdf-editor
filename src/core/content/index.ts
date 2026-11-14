// Public API of the content engine: analyse a page for the editor, and apply edits to a page.
import { PDFDocument, PDFPage, PDFName, StandardFonts } from 'pdf-lib';
import { Encodings, Font as StdFont } from '@pdf-lib/standard-fonts';
import { analyze, PageAnalysis, PageObj } from './analyze';
import { rewriteContent, ObjEdits, ExtraText, FallbackFont, isEdited, replacementWidth } from './rewrite';
import type { FontInfo } from './fontinfo';

export type { PageAnalysis, PageObj, ObjEdits, ExtraText };
export { isEdited };
export type { ObjEdit } from './rewrite';

/** The standard font that best matches an embedded one. */
export function standardFor(f: FontInfo | null): StandardFonts {
  const b = !!f?.bold, i = !!f?.italic;
  if (f?.mono) return b && i ? StandardFonts.CourierBoldOblique : b ? StandardFonts.CourierBold : i ? StandardFonts.CourierOblique : StandardFonts.Courier;
  if (f?.serif) return b && i ? StandardFonts.TimesRomanBoldItalic : b ? StandardFonts.TimesRomanBold : i ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
  return b && i ? StandardFonts.HelveticaBoldOblique : b ? StandardFonts.HelveticaBold : i ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
}

/** Width in 1/1000 em of `text` in the standard font that replaces `f`. */
export function standardTextWidth(f: FontInfo | null, text: string): number {
  const font = StdFont.load(standardFor(f) as any);
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const name = Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp) ? Encodings.WinAnsi.encodeUnicodeCodePoint(cp).name : 'question';
    w += (font.getWidthOfGlyph(name) as number) || 500;
  }
  return w;
}

export function analyzePage(doc: PDFDocument, page: PDFPage): PageAnalysis {
  const cb = page.getCropBox();
  return analyze(doc.context, page.node, { x: cb.x, y: cb.y, w: cb.width, h: cb.height });
}

/** Rewrite `page` (inside `doc`) with the edits. Returns Urdu replacements to draw afterwards. */
export async function applyObjEdits(doc: PDFDocument, page: PDFPage, edits: ObjEdits): Promise<ExtraText[]> {
  if (!Object.values(edits).some(isEdited)) return [];
  const an = analyzePage(doc, page);
  const fonts = new Map<string, FallbackFont>();
  const { bytes, extra } = await rewriteContent(an, edits, {
    async fallbackFont(f) {
      const name = standardFor(f);
      if (!fonts.has(name)) {
        const pf = await doc.embedFont(name);
        const key = page.node.newFontDictionary('EditF', pf.ref).decodeText();
        const set = new Set(pf.getCharacterSet());
        fonts.set(name, {
          key,
          encode: t => pf.encodeText(Array.from(t, c => (set.has(c.codePointAt(0)!) ? c : '?')).join('')).toString().slice(1, -1),
        });
      }
      return fonts.get(name)!;
    },
  });
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(bytes)));
  return extra;
}

/** Width the edited text will take (page points), so the selection box matches the result. */
export const editedTextWidth = (o: PageObj, text: string) => replacementWidth(o, text, standardTextWidth);
