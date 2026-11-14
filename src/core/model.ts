// Core document model: no UI code here.
// All positions are in PDF points (1/72 inch), measured from the TOP-LEFT of the
// page's unrotated crop box. Export converts to PDF's bottom-left origin.

export type FontName = 'Helvetica' | 'Times' | 'Courier' | 'Nastaliq' | 'Naskh';

interface Base { id: string }
export interface TextAnn extends Base {
  type: 'text'; x: number; y: number; w: number; h: number;
  text: string; font: FontName; fontLabel?: string; size: number; color: string; bold: boolean; italic: boolean;
}
export interface BoxAnn extends Base {
  type: 'highlight' | 'rect' | 'ellipse' | 'whiteout';
  x: number; y: number; w: number; h: number; color: string; width: number; opacity: number;
}
export interface LineAnn extends Base {
  type: 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number; color: string; width: number;
}
export interface InkAnn extends Base { type: 'ink'; points: number[]; color: string; width: number }
export interface ImageAnn extends Base { type: 'image'; x: number; y: number; w: number; h: number; assetId: string }
export type Annotation = TextAnn | BoxAnn | LineAnn | InkAnn | ImageAnn;

export interface PageRef {
  id: string;
  sourceId: string | null;   // null = blank page
  sourceIndex: number;       // 0-based page index inside the source file
  width: number; height: number;  // unrotated crop box size in points
  baseRotation: number;      // rotation stored in the original file
  rotation: number;          // extra rotation added by the user (0/90/180/270)
  annotations: Annotation[];
  /** Edits to objects already in the PDF (Edit PDF mode), keyed by object id (see core/content). */
  objEdits?: Record<string, ObjEdit>;
}
export interface ObjEdit { hidden?: boolean; dx?: number; dy?: number; sx?: number; sy?: number; text?: string }
export const hasObjEdits = (p: PageRef) => !!p.objEdits && Object.keys(p.objEdits).length > 0;

export interface Asset { id: string; mime: 'image/png' | 'image/jpeg'; dataUrl: string; w: number; h: number }

let counter = 0;
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

export function annBounds(a: Annotation) {
  switch (a.type) {
    case 'line': case 'arrow':
      return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
    case 'ink': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < a.points.length; i += 2) {
        x0 = Math.min(x0, a.points[i]); x1 = Math.max(x1, a.points[i]);
        y0 = Math.min(y0, a.points[i + 1]); y1 = Math.max(y1, a.points[i + 1]);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    default: return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}

export function moveAnn(a: Annotation, dx: number, dy: number) {
  switch (a.type) {
    case 'line': case 'arrow': a.x1 += dx; a.x2 += dx; a.y1 += dy; a.y2 += dy; break;
    case 'ink': for (let i = 0; i < a.points.length; i += 2) { a.points[i] += dx; a.points[i + 1] += dy; } break;
    default: a.x += dx; a.y += dy;
  }
}

/** Scale an annotation so its bounding box becomes `to` (used by the resize handle). */
export function resizeAnn(a: Annotation, from: { x: number; y: number; w: number; h: number }, to: { x: number; y: number; w: number; h: number }) {
  const sx = from.w ? to.w / from.w : 1, sy = from.h ? to.h / from.h : 1;
  const mx = (v: number) => to.x + (v - from.x) * sx, my = (v: number) => to.y + (v - from.y) * sy;
  switch (a.type) {
    case 'line': case 'arrow': a.x1 = mx(a.x1); a.x2 = mx(a.x2); a.y1 = my(a.y1); a.y2 = my(a.y2); break;
    case 'ink': for (let i = 0; i < a.points.length; i += 2) { a.points[i] = mx(a.points[i]); a.points[i + 1] = my(a.points[i + 1]); } break;
    default: a.x = to.x; a.y = to.y; a.w = to.w; a.h = to.h;
  }
}

/** Store with snapshot-based undo/redo. Mutate `pages` only between checkpoint() and changed(). */
export class DocStore {
  pages: PageRef[] = [];
  assets = new Map<string, Asset>();
  fileName = 'document.pdf';
  private undoStack: PageRef[][] = [];
  private redoStack: PageRef[][] = [];
  private listeners = new Set<() => void>();
  static MAX_HISTORY = 200;

  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { this.listeners.forEach(f => f()); }

  /** Save the current state so the next change can be undone. */
  checkpoint() {
    this.undoStack.push(structuredClone(this.pages));
    if (this.undoStack.length > DocStore.MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }
  /** checkpoint + mutate + notify, in one call. */
  apply(fn: (pages: PageRef[]) => void) { this.checkpoint(); fn(this.pages); this.changed(); }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  undo() {
    const prev = this.undoStack.pop(); if (!prev) return;
    this.redoStack.push(this.pages); this.pages = prev; this.changed();
  }
  redo() {
    const next = this.redoStack.pop(); if (!next) return;
    this.undoStack.push(this.pages); this.pages = next; this.changed();
  }
  reset(pages: PageRef[], fileName?: string) {
    this.pages = pages; this.undoStack = []; this.redoStack = [];
    if (fileName) this.fileName = fileName;
    this.changed();
  }
  findAnn(id: string): { page: PageRef; ann: Annotation } | null {
    for (const page of this.pages) { const ann = page.annotations.find(a => a.id === id); if (ann) return { page, ann }; }
    return null;
  }
}

/** Parse "1-3, 5, 8-" into groups of 0-based page indexes. Each comma part = one output file. */
export function parseRanges(input: string, pageCount: number): number[][] {
  const groups: number[][] = [];
  for (const raw of input.split(',')) {
    const part = raw.trim(); if (!part) continue;
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    let a: number, b: number;
    if (m) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : pageCount; }
    else if (/^\d+$/.test(part)) { a = b = +part; }
    else throw new Error(`"${part}" is not a page or range`);
    if (a < 1 || b > pageCount || a > b) throw new Error(`"${part}" is outside pages 1-${pageCount}`);
    groups.push(Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i));
  }
  if (!groups.length) throw new Error('Enter at least one page or range');
  return groups;
}

export function chunkEvery(n: number, pageCount: number): number[][] {
  if (!(n >= 1)) throw new Error('Pages per file must be 1 or more');
  const out: number[][] = [];
  for (let i = 0; i < pageCount; i += n) out.push(Array.from({ length: Math.min(n, pageCount - i) }, (_, k) => i + k));
  return out;
}

/** Paint order: whiteouts at the bottom, then highlights, then everything else (stable). */
const LAYER: Partial<Record<Annotation['type'], number>> = { whiteout: 0, highlight: 1 };
export const drawOrder = (anns: Annotation[]) =>
  anns.map((a, i) => [a, i] as const).sort((x, y) => ((LAYER[x[0].type] ?? 2) - (LAYER[y[0].type] ?? 2)) || x[1] - y[1]).map(x => x[0]);
