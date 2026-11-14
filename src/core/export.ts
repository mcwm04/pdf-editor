// pdf-lib writer: builds a new PDF from the page list and flattens annotations into it.
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, degrees, BlendMode, LineCapStyle, PDFImage } from 'pdf-lib';
import { Annotation, Asset, PageRef, TextAnn, drawOrder } from './model';
import { sources, rasterise, setEditedPageBuilder } from './render';
import { applyObjEdits } from './content';
import { hasObjEdits } from './model';
import { METRICS, effectiveFont, isUrduFont } from './fonts';
import { UnicodeTextWriter, getHarfBuzz } from './urdu-text';

const hexToRgb = (hex: string) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

const FONT_MAP: Record<string, StandardFonts[]> = {
  // [regular, bold, italic, bold-italic]
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};


export interface ExportOptions { onProgress?: (done: number, total: number) => void; onNote?: (msg: string) => void }

export async function exportPdf(pages: PageRef[], assets: Map<string, Asset>, opts: ExportOptions = {}): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  out.setProducer('PDF Editor'); out.setCreator('PDF Editor');

  const loaded = new Map<string, PDFDocument | null>();
  const getLib = async (sourceId: string) => {
    if (loaded.has(sourceId)) return loaded.get(sourceId)!;
    const src = sources.get(sourceId)!;
    let doc: PDFDocument | null = null;
    if (!src.encrypted) {
      try { doc = await PDFDocument.load(src.bytes, { updateMetadata: false }); } catch { doc = null; }
    }
    loaded.set(sourceId, doc);
    return doc;
  };

  const ARABIC = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
  const needsUnicode = pages.some(p => p.annotations.some(a => a.type === 'text' && isUrduFont(effectiveFont(a.font, a.text)))
    || Object.values(p.objEdits || {}).some(e => e.text && ARABIC.test(e.text)));
  const unicode = new UnicodeTextWriter(out, needsUnicode ? await getHarfBuzz() : null);
  const fonts = new Map<string, PDFFont>();
  const getFont = async (a: TextAnn) => {
    const name = FONT_MAP[a.font][(a.bold ? 1 : 0) + (a.italic ? 2 : 0)];
    if (!fonts.has(name)) fonts.set(name, await out.embedFont(name));
    return fonts.get(name)!;
  };
  const images = new Map<string, PDFImage>();
  const getImage = async (assetId: string) => {
    if (images.has(assetId)) return images.get(assetId)!;
    const asset = assets.get(assetId)!;
    const bytes = Uint8Array.from(atob(asset.dataUrl.split(',')[1]), c => c.charCodeAt(0));
    const img = asset.mime === 'image/png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
    images.set(assetId, img); return img;
  };

  for (let i = 0; i < pages.length; i++) {
    const ref = pages[i];
    let page: PDFPage;
    let ox = 0, oy = 0; // crop box origin
    const lib = ref.sourceId ? await getLib(ref.sourceId) : null;
    if (ref.sourceId && lib) {
      const [copied] = await out.copyPages(lib, [ref.sourceIndex]);
      page = out.addPage(copied);
      const cb = page.getCropBox(); ox = cb.x; oy = cb.y;
      if (hasObjEdits(ref)) {
        // Edit PDF mode: rewrite the page's own content; Urdu replacements are drawn as text below.
        const extra = await applyObjEdits(out, page, ref.objEdits!);
        for (const x of extra) {
          const m = METRICS.Nastaliq;
          await unicode.draw(page, { id: '', type: 'text', x: x.x, y: x.y - x.size * m.base, w: x.w, h: x.size * m.lh, text: x.text, font: 'Nastaliq', size: x.size, color: x.color, bold: x.bold, italic: false },
            'Nastaliq', ox, oy + ref.height, (() => { const c = hexToRgb(x.color); return [c.red, c.green, c.blue] as [number, number, number]; })());
        }
      }
    } else if (ref.sourceId) {
      // Fallback for files pdf-lib cannot parse (e.g. password-protected): keep the look as an image.
      page = out.addPage([ref.width, ref.height]);
      const png = await out.embedPng(await rasterise(ref, 2));
      page.drawImage(png, { x: 0, y: 0, width: ref.width, height: ref.height });
    } else {
      page = out.addPage([ref.width, ref.height]);
    }
    page.setRotation(degrees((ref.baseRotation + ref.rotation) % 360));
    const top = oy + ref.height; // PDF y of the top edge
    for (const a of drawOrder(ref.annotations)) await drawAnn(page, a, ox, top, getFont, getImage, unicode);
    opts.onProgress?.(i + 1, pages.length);
  }
  unicode.finish();
  if (unicode.rasterised) opts.onNote?.('Urdu text was saved as an image in this viewer, so it cannot be selected or copied in the PDF.');
  return out.save();
}

async function drawAnn(page: PDFPage, a: Annotation, ox: number, top: number,
  getFont: (a: TextAnn) => Promise<PDFFont>, getImage: (id: string) => Promise<PDFImage>, unicode: UnicodeTextWriter) {
  const X = (x: number) => ox + x, Y = (y: number) => top - y;
  const svgAt = { x: ox, y: top }; // drawSvgPath uses a top-left, y-down system: same as ours
  switch (a.type) {
    case 'text': {
      const ef = effectiveFont(a.font, a.text);
      if (isUrduFont(ef)) { const c = hexToRgb(a.color); await unicode.draw(page, a, ef, ox, top, [c.red, c.green, c.blue]); break; }
      const { base, lh } = METRICS[a.font];
      const font = await getFont(a);
      const allowed = new Set(font.getCharacterSet());
      const safe = (s: string) => Array.from(s).map(ch => allowed.has(ch.codePointAt(0)!) ? ch : '?').join('');
      a.text.split('\n').forEach((line, i) => {
        if (!line) return;
        page.drawText(safe(line), { x: X(a.x), y: Y(a.y + a.size * (base + lh * i)), size: a.size, font, color: hexToRgb(a.color) });
      });
      break;
    }
    case 'highlight':
      page.drawRectangle({ x: X(a.x), y: Y(a.y + a.h), width: a.w, height: a.h, color: hexToRgb(a.color), opacity: a.opacity, blendMode: BlendMode.Multiply });
      break;
    case 'whiteout':
      page.drawRectangle({ x: X(a.x), y: Y(a.y + a.h), width: a.w, height: a.h, color: hexToRgb(a.color) });
      break;
    case 'rect':
      page.drawRectangle({ x: X(a.x), y: Y(a.y + a.h), width: a.w, height: a.h, borderColor: hexToRgb(a.color), borderWidth: a.width, borderOpacity: a.opacity });
      break;
    case 'ellipse':
      page.drawEllipse({ x: X(a.x + a.w / 2), y: Y(a.y + a.h / 2), xScale: a.w / 2, yScale: a.h / 2, borderColor: hexToRgb(a.color), borderWidth: a.width, borderOpacity: a.opacity });
      break;
    case 'line': case 'arrow': {
      page.drawSvgPath(`M ${a.x1} ${a.y1} L ${a.x2} ${a.y2}`, { ...svgAt, borderColor: hexToRgb(a.color), borderWidth: a.width, borderLineCap: LineCapStyle.Round });
      if (a.type === 'arrow') page.drawSvgPath(arrowHead(a.x1, a.y1, a.x2, a.y2, a.width), { ...svgAt, color: hexToRgb(a.color) });
      break;
    }
    case 'ink': {
      const p = a.points; if (p.length < 2) break;
      let d = `M ${p[0]} ${p[1]}`;
      for (let i = 2; i < p.length; i += 2) d += ` L ${p[i]} ${p[i + 1]}`;
      if (p.length === 2) d += ` L ${p[0] + 0.01} ${p[1]}`;
      page.drawSvgPath(d, { ...svgAt, borderColor: hexToRgb(a.color), borderWidth: a.width, borderLineCap: LineCapStyle.Round });
      break;
    }
    case 'image': {
      const img = await getImage(a.assetId);
      page.drawImage(img, { x: X(a.x), y: Y(a.y + a.h), width: a.w, height: a.h });
      break;
    }
  }
}

/** Triangle path for an arrow tip at (x2, y2). Shared with the UI. */
export function arrowHead(x1: number, y1: number, x2: number, y2: number, width: number) {
  const len = Math.max(8, width * 4), ang = Math.atan2(y2 - y1, x2 - x1), spread = Math.PI / 7;
  const ax = x2 - len * Math.cos(ang - spread), ay = y2 - len * Math.sin(ang - spread);
  const bx = x2 - len * Math.cos(ang + spread), by = y2 - len * Math.sin(ang + spread);
  return `M ${x2} ${y2} L ${ax} ${ay} L ${bx} ${by} Z`;
}

// Live preview of Edit-PDF changes: the screen renders the page from the same writer.
setEditedPageBuilder(p => exportPdf([p], new Map()));
