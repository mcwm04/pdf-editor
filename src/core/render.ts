// PDF.js wrapper: loads files in a Web Worker and renders pages to canvas.
import * as pdfjs from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PageRef, uid, hasObjEdits } from './model';

pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();

export interface Source { id: string; name: string; bytes: Uint8Array; pdf: PDFDocumentProxy; encrypted: boolean }
export const sources = new Map<string, Source>();

export type AskPassword = (fileName: string, wrong: boolean) => Promise<string | null>;

export async function loadPdf(bytes: Uint8Array, name: string, askPassword: AskPassword): Promise<{ source: Source; pages: PageRef[] }> {
  let encrypted = false;
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
  task.onPassword = async (update: (p: string) => void, reason: number) => {
    encrypted = true;
    const pw = await askPassword(name, reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    if (pw === null) { task.destroy(); return; }
    update(pw);
  };
  let pdf: PDFDocumentProxy;
  try { pdf = await task.promise; }
  catch (e: any) {
    if (e?.name === 'PasswordException' || /destroyed/i.test(e?.message || '')) throw new Error(`"${name}" needs a password`);
    throw new Error(`"${name}" is not a valid PDF (${e?.message || e})`);
  }
  const source: Source = { id: uid('src'), name, bytes, pdf, encrypted };
  sources.set(source.id, source);
  const pages: PageRef[] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const p = await pdf.getPage(i + 1);
    const [x0, y0, x1, y1] = p.view;
    pages.push({
      id: uid('pg'), sourceId: source.id, sourceIndex: i,
      width: x1 - x0, height: y1 - y0, baseRotation: p.rotate || 0, rotation: 0, annotations: [],
    });
  }
  return { source, pages };
}

export function blankPage(width = 595.28, height = 841.89): PageRef {
  return { id: uid('pg'), sourceId: null, sourceIndex: 0, width, height, baseRotation: 0, rotation: 0, annotations: [] };
}

const tasks = new WeakMap<HTMLCanvasElement, { cancel(): void }>();

// Pages with Edit-PDF changes are rendered from a rebuilt one-page PDF, so the screen shows
// exactly what will be saved. The builder is registered by export.ts (avoids a circular import).
let buildEdited: ((p: PageRef) => Promise<Uint8Array>) | null = null;
export const setEditedPageBuilder = (fn: (p: PageRef) => Promise<Uint8Array>) => { buildEdited = fn; };
const editedDocs = new Map<string, Promise<PDFDocumentProxy>>();
export const editsKey = (p: PageRef) => `${p.sourceId}:${p.sourceIndex}:${hasObjEdits(p) ? JSON.stringify(p.objEdits) : ''}`;
async function pdfPageFor(page: PageRef) {
  const src = sources.get(page.sourceId!)!;
  if (!hasObjEdits(page) || !buildEdited || src.encrypted) return src.pdf.getPage(page.sourceIndex + 1);
  const key = editsKey(page);
  let doc = editedDocs.get(key);
  if (!doc) {
    doc = buildEdited({ ...page, annotations: [], rotation: 0 }).then(bytes => pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise);
    editedDocs.set(key, doc);
    if (editedDocs.size > 40) { const [k, d] = editedDocs.entries().next().value!; editedDocs.delete(k); d.then(x => x.destroy()).catch(() => {}); }
  }
  return (await doc).getPage(1);
}

/** Render the unrotated page into `canvas` at `scale` CSS pixels per point. */
export async function renderPage(page: PageRef, scale: number, canvas: HTMLCanvasElement, dpr = window.devicePixelRatio || 1) {
  tasks.get(canvas)?.cancel();
  const w = Math.max(1, Math.round(page.width * scale * dpr)), h = Math.max(1, Math.round(page.height * scale * dpr));
  const src = page.sourceId ? sources.get(page.sourceId) : null;
  if (!src) {
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    return;
  }
  const p = await pdfPageFor(page);
  const vp = p.getViewport({ scale: scale * dpr, rotation: 0 });
  // Render off-screen first so the old image stays visible until the new one is ready.
  const off = document.createElement('canvas');
  off.width = Math.round(vp.width); off.height = Math.round(vp.height);
  const task = p.render({ canvasContext: off.getContext('2d')!, viewport: vp });
  tasks.set(canvas, task);
  try { await task.promise; }
  catch (e: any) { if (e?.name === 'RenderingCancelledException') return; throw e; }
  canvas.width = off.width; canvas.height = off.height;
  canvas.getContext('2d')!.drawImage(off, 0, 0);
}

const thumbCache = new Map<string, string>();
/** Small PNG data URL of the unrotated page (cached). */
export async function thumbnail(page: PageRef, width = 140): Promise<string> {
  const key = `${editsKey(page)}:${page.width}x${page.height}`;
  const hit = thumbCache.get(key); if (hit) return hit;
  const c = document.createElement('canvas');
  await renderPage(page, width / page.width, c, 1);
  const url = c.toDataURL('image/png');
  thumbCache.set(key, url);
  return url;
}

/** Rasterise a page (no annotations) to PNG bytes: used when pdf-lib cannot read a file (e.g. encrypted). */
export async function rasterise(page: PageRef, scale = 2): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  await renderPage(page, scale, c, 1);
  const blob: Blob = await new Promise(r => c.toBlob(b => r(b!), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
