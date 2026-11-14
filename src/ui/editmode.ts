// Edit PDF mode: select, move, resize, delete and re-word objects that are already in the PDF.
// The edits are stored on the page (objEdits); the page is then re-rendered from the rewritten PDF.
import { PDFDocument } from 'pdf-lib';
import { analyzePage, PageAnalysis, PageObj, editedTextWidth } from '../core/content';
import { sources } from '../core/render';
import type { ObjEdit, PageRef } from '../core/model';
import type { Viewer, PageView } from './viewer';
import { toast } from './dialogs';

type Box = { x: number; y: number; w: number; h: number };
interface Eff { o: PageObj; box: Box; edit: ObjEdit }

const libs = new Map<string, Promise<PDFDocument | null>>();
const analyses = new Map<string, Promise<PageAnalysis | null>>();
const ready = new Map<string, PageAnalysis | null>();
const keyOf = (p: PageRef) => `${p.sourceId}:${p.sourceIndex}`;

function libFor(sourceId: string): Promise<PDFDocument | null> {
  let l = libs.get(sourceId);
  if (!l) {
    const src = sources.get(sourceId);
    l = !src || src.encrypted ? Promise.resolve(null) : PDFDocument.load(src.bytes, { updateMetadata: false }).catch(() => null);
    libs.set(sourceId, l);
  }
  return l;
}
export function analysisFor(page: PageRef): Promise<PageAnalysis | null> {
  if (!page.sourceId) return Promise.resolve(null);
  const k = keyOf(page);
  let a = analyses.get(k);
  if (!a) {
    a = libFor(page.sourceId).then(lib => {
      if (!lib) return null;
      try { return analyzePage(lib, lib.getPage(page.sourceIndex)); } catch (e) { console.error('analyse failed', e); return null; }
    }).then(r => { ready.set(k, r); return r; });
    analyses.set(k, a);
  }
  return a;
}

const SVGNS = 'http://www.w3.org/2000/svg';
const s = (tag: string, attrs: Record<string, any> = {}) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, String(v));
  return e;
};

type Drag = { kind: 'move' | 'resize'; v: PageView; eff: Eff; start: { x: number; y: number }; cur: { x: number; y: number }; ghost: string; moved: boolean; shift: boolean };

export class EditMode {
  sel: { pageId: string; id: string } | null = null;
  private hover: { pageId: string; id: string } | null = null;
  private drag: Drag | null = null;
  private editor: { v: PageView; eff: Eff; fo: SVGForeignObjectElement; input: HTMLInputElement } | null = null;
  private warned = new Set<string>();

  constructor(private vw: Viewer) {}

  // ---------- geometry ----------
  private effective(page: PageRef, an: PageAnalysis): Eff[] {
    const out: Eff[] = [];
    for (const o of an.objects) {
      if (o.fullPage) continue;
      const edit = page.objEdits?.[o.id] ?? {};
      if (edit.hidden) continue;
      const sx = edit.sx ?? 1, sy = edit.sy ?? 1;
      let w = o.bbox.w, x = o.bbox.x;
      if (o.kind === 'text' && edit.text != null) {
        w = editedTextWidth(o, edit.text);
        if (/[؀-ۿ]/.test(edit.text)) x = o.bbox.x + o.bbox.w - w; // right-aligned Urdu
      }
      out.push({ o, edit, box: { x: x + (edit.dx ?? 0), y: o.bbox.y + (edit.dy ?? 0), w: Math.max(w * sx, 1), h: Math.max(o.bbox.h * sy, 1) } });
    }
    return out;
  }
  private hit(page: PageRef, an: PageAnalysis, p: { x: number; y: number }): Eff | null {
    let best: Eff | null = null, bestArea = Infinity;
    for (const e of this.effective(page, an)) {
      const pad = 3, b = e.box;
      const inside = p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
      if (!inside) continue;
      // An outline-only shape (e.g. a page border) is picked only near its edge.
      if (e.o.kind === 'shape' && e.o.label === 'Line' && b.w > 30 && b.h > 30) {
        const edge = Math.min(p.x - b.x, b.x + b.w - p.x, p.y - b.y, b.y + b.h - p.y);
        if (edge > 6) continue;
      }
      const area = Math.max(b.w, 2) * Math.max(b.h, 2);
      if (area < bestArea) { best = e; bestArea = area; }
    }
    return best;
  }
  private find(page: PageRef, id: string): Eff | null {
    const an = ready.get(keyOf(page));
    return an ? this.effective(page, an).find(e => e.o.id === id) ?? null : null;
  }

  // ---------- drawing ----------
  draw(v: PageView) {
    const layer = v.editLayer;
    layer.replaceChildren();
    if (this.vw.tool !== 'edit') return;
    const an = ready.get(keyOf(v.page));
    if (an === undefined) { analysisFor(v.page).then(() => this.draw(v)); return; }
    if (!an) return;
    const z = this.vw.zoom, sw = 1.5 / z;
    const outline = (b: Box, cls: string) => s('rect', { class: cls, x: b.x - 2 / z, y: b.y - 2 / z, width: b.w + 4 / z, height: b.h + 4 / z, 'stroke-width': sw });
    const effs = this.effective(v.page, an);
    if (this.hover?.pageId === v.page.id && this.hover.id !== this.sel?.id) {
      const h = effs.find(e => e.o.id === this.hover!.id);
      if (h) layer.append(outline(h.box, 'edit-hover'));
    }
    const d = this.drag;
    if (d && d.v === v) {
      const b = this.dragBox(d);
      layer.append(s('rect', { class: 'edit-lift', x: d.eff.box.x, y: d.eff.box.y, width: d.eff.box.w, height: d.eff.box.h }));
      layer.append(s('image', { href: d.ghost, x: b.x, y: b.y, width: b.w, height: b.h, preserveAspectRatio: 'none', opacity: 0.85 }));
      layer.append(outline(b, 'edit-sel'));
      return;
    }
    if (this.sel?.pageId === v.page.id && !this.editor) {
      const e = effs.find(x => x.o.id === this.sel!.id);
      if (!e) return;
      layer.append(outline(e.box, 'edit-sel'));
      if (e.o.kind !== 'text') {
        const hs = 9 / z;
        layer.append(s('rect', { class: 'sel-handle', 'data-edit-handle': '1', x: e.box.x + e.box.w + 2 / z - hs / 2, y: e.box.y + e.box.h + 2 / z - hs / 2, width: hs, height: hs, 'stroke-width': sw }));
      }
    }
  }
  redrawAll() { for (const v of this.vw.pageViews()) this.draw(v); }

  // ---------- pointer ----------
  onHover(e: PointerEvent, v: PageView) {
    if (this.drag) return;
    const an = ready.get(keyOf(v.page));
    if (an === undefined) { analysisFor(v.page); return; }
    const h = an ? this.hit(v.page, an, this.vw.pagePoint(e, v)) : null;
    const next = h ? { pageId: v.page.id, id: h.o.id } : null;
    if (next?.id !== this.hover?.id || next?.pageId !== this.hover?.pageId) {
      const prevPage = this.hover?.pageId;
      this.hover = next;
      v.svg.style.cursor = h ? (h.o.kind === 'text' ? 'move' : 'move') : 'default';
      this.draw(v);
      if (prevPage && prevPage !== v.page.id) { const pv = this.vw.viewFor(prevPage); if (pv) this.draw(pv); }
    }
  }
  onLeave(v: PageView) { if (this.hover?.pageId === v.page.id) { this.hover = null; this.draw(v); } }

  async onDown(e: PointerEvent, v: PageView) {
    if (this.editor) { if (this.editor.fo.contains(e.target as Node)) return; this.commitText(); }
    const an = ready.get(keyOf(v.page)) ?? await analysisFor(v.page);
    if (!an) {
      const src = v.page.sourceId ? sources.get(v.page.sourceId) : null;
      if (src?.encrypted && !this.warned.has(src.id)) { this.warned.add(src.id); toast('This file is password-protected, so its own content cannot be changed. You can still add text and drawings on top.', 'error', 7000); }
      return;
    }
    const p = this.vw.pagePoint(e, v);
    const onHandle = (e.target as Element).closest?.('[data-edit-handle]');
    const cur = this.sel && this.sel.pageId === v.page.id ? this.find(v.page, this.sel.id) : null;
    const h = onHandle && cur ? cur : this.hit(v.page, an, p);
    this.select(h ? { pageId: v.page.id, id: h.o.id } : null);
    if (!h) return;
    this.drag = { kind: onHandle ? 'resize' : 'move', v, eff: h, start: p, cur: p, ghost: this.crop(v, h.box), moved: false, shift: e.shiftKey };
  }
  onMove(e: PointerEvent) {
    const d = this.drag; if (!d) return;
    d.cur = this.vw.pagePoint(e, d.v); d.shift = e.shiftKey;
    if (!d.moved && Math.hypot(d.cur.x - d.start.x, d.cur.y - d.start.y) * this.vw.zoom < 3) return;
    d.moved = true;
    this.draw(d.v);
  }
  onUp() {
    const d = this.drag; if (!d) return;
    this.drag = null;
    if (!d.moved) { this.draw(d.v); return; }
    const nb = this.dragBox(d), ob = d.eff.box, o = d.eff.o;
    this.update(d.v.page.id, o.id, ed => {
      if (d.kind === 'move') { ed.dx = (ed.dx ?? 0) + nb.x - ob.x; ed.dy = (ed.dy ?? 0) + nb.y - ob.y; }
      else { ed.sx = (ed.sx ?? 1) * nb.w / ob.w; ed.sy = (ed.sy ?? 1) * nb.h / ob.h; }
    });
  }
  private dragBox(d: Drag): Box {
    const b = d.eff.box, dx = d.cur.x - d.start.x, dy = d.cur.y - d.start.y;
    if (d.kind === 'move') return { ...b, x: b.x + dx, y: b.y + dy };
    let w = Math.max(4, b.w + dx), h = Math.max(4, b.h + dy);
    if (d.eff.o.kind === 'image' || d.shift) { const k = Math.max(w / b.w, h / b.h); w = b.w * k; h = b.h * k; }
    return { ...b, w, h };
  }
  onDouble(e: MouseEvent, v: PageView) {
    const an = ready.get(keyOf(v.page)); if (!an) return;
    const h = this.hit(v.page, an, this.vw.pagePoint(e, v));
    if (h?.o.kind === 'text') this.openText(v, h);
  }

  /** Picture of the object as currently rendered, used while dragging. */
  private crop(v: PageView, b: Box): string {
    const c = v.canvas, k = c.width / v.page.width;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(b.w * k)); out.height = Math.max(1, Math.round(b.h * k));
    try { out.getContext('2d')!.drawImage(c, b.x * k, b.y * k, b.w * k, b.h * k, 0, 0, out.width, out.height); return out.toDataURL('image/png'); }
    catch { return ''; }
  }

  // ---------- commands ----------
  select(sel: { pageId: string; id: string } | null) {
    const prev = this.sel?.pageId;
    this.sel = sel;
    if (prev) { const pv = this.vw.viewFor(prev); if (pv) this.draw(pv); }
    if (sel) { const pv = this.vw.viewFor(sel.pageId); if (pv) this.draw(pv); }
    this.vw.onChange();
  }
  selected(): Eff | null {
    if (!this.sel) return null;
    const page = this.vw.store.pages.find(p => p.id === this.sel!.pageId);
    return page ? this.find(page, this.sel.id) : null;
  }
  private update(pageId: string, id: string, fn: (e: ObjEdit) => void) {
    this.vw.store.apply(pages => {
      const page = pages.find(p => p.id === pageId)!;
      const edits = { ...(page.objEdits ?? {}) };
      const ed = { ...(edits[id] ?? {}) };
      fn(ed);
      edits[id] = ed;
      page.objEdits = edits;
    });
  }
  deleteSelected() {
    if (!this.sel) return;
    const { pageId, id } = this.sel;
    this.update(pageId, id, ed => { ed.hidden = true; });
    this.select(null);
    toast('Removed from the PDF. Press Ctrl+Z to undo.');
  }
  nudge(dx: number, dy: number) {
    if (!this.sel) return;
    this.update(this.sel.pageId, this.sel.id, ed => { ed.dx = (ed.dx ?? 0) + dx; ed.dy = (ed.dy ?? 0) + dy; });
  }
  editSelectedText() {
    const eff = this.selected();
    if (!eff || eff.o.kind !== 'text') return;
    const v = this.vw.viewFor(this.sel!.pageId);
    if (v) this.openText(v, eff);
  }
  clear() { if (this.editor) this.commitText(); this.sel = null; this.hover = null; this.drag = null; this.redrawAll(); }
  get editing() { return !!this.editor; }

  // ---------- editing a line of existing text ----------
  private openText(v: PageView, eff: Eff) {
    const o = eff.o, f = o.font;
    const current = eff.edit.text ?? o.text ?? '';
    if (current.includes('�') && !this.warned.has(o.id)) {
      this.warned.add(o.id);
      toast('Some letters in this line could not be read from the file and show as �. Retype them.', 'info', 6000);
    }
    const size = o.size ?? 12;
    const family = f?.mono ? '"Courier New", Courier, monospace' : f?.serif ? '"Times New Roman", Times, "Liberation Serif", serif' : 'Arial, Helvetica, "Liberation Sans", sans-serif';
    const baseY = (o.baseline?.y ?? o.bbox.y + size) + (eff.edit.dy ?? 0);
    const fo = s('foreignObject', { x: eff.box.x - 3, y: baseY - size * 0.95 - 3, width: Math.max(eff.box.w + size * 6, 160), height: size * 1.2 + 8 }) as SVGForeignObjectElement;
    const input = document.createElement('input');
    input.type = 'text'; input.value = current; input.className = 'obj-text-editor'; input.dir = 'auto';
    input.setAttribute('aria-label', 'Edit text');
    Object.assign(input.style, {
      fontFamily: family, fontSize: `${size}px`, lineHeight: '1.2', color: o.color || '#000',
      fontWeight: f?.bold ? '700' : '400', fontStyle: f?.italic ? 'italic' : 'normal',
      width: `${Math.max(eff.box.w + size * 5, 150)}px`, height: `${size * 1.2 + 6}px`,
    });
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); this.commitText(); }
      if (ev.key === 'Escape') { ev.preventDefault(); input.value = current; this.commitText(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { if (this.editor?.input === input) this.commitText(); }, 0));
    fo.append(input);
    this.editor = { v, eff, fo, input };
    this.draw(v);
    v.editLayer.append(fo);
    requestAnimationFrame(() => { input.focus(); input.select(); });
    this.vw.onChange();
  }
  commitText() {
    const ed = this.editor; if (!ed) return;
    this.editor = null;
    ed.fo.remove();
    const before = ed.eff.edit.text ?? ed.eff.o.text ?? '';
    const text = ed.input.value;
    if (text !== before) {
      this.update(ed.v.page.id, ed.eff.o.id, e => {
        if (!text.trim()) e.hidden = true;
        else if (text === ed.eff.o.text && !e.dx && !e.dy) delete e.text;
        else e.text = text;
      });
      if (text.trim() && ed.eff.o.font && ed.eff.o.font.encode(text) === null && !/[؀-ۿ]/.test(text)) {
        toast('The original font does not have all these letters, so this line now uses the closest standard font.', 'info', 6000);
      }
    }
    this.draw(ed.v);
    this.vw.onChange();
  }
}
