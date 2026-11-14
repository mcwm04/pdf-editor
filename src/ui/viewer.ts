// Page viewer + edit layer. Pages are canvases (PDF.js); edits are drawn in an SVG overlay
// whose user space is the page's unrotated point space, so zoom and rotation never touch the model.
import { drawOrder, Annotation, Asset, DocStore, PageRef, TextAnn, BoxAnn, LineAnn, InkAnn, ImageAnn, FontName, annBounds, moveAnn, resizeAnn, uid } from '../core/model';
import { renderPage, editsKey } from '../core/render';
import { EditMode } from './editmode';
import { arrowHead } from '../core/export';
import { FONT_CSS, METRICS, effectiveFont, isUrduFont, isRtlText, hasArabicScript } from '../core/fonts';
export { FONT_CSS };

export type Tool = 'select' | 'edit' | 'text' | 'highlight' | 'pen' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'whiteout';
export interface Style { color: string; width: number; size: number; font: FontName; fontLabel?: string; bold: boolean; italic: boolean; opacity: number }


const base: Style = { color: '#1f2937', width: 2, size: 14, font: 'Helvetica', bold: false, italic: false, opacity: 1 };
export const defaultStyles = (): Record<Tool, Style> => ({
  select: { ...base },
  edit: { ...base },
  text: { ...base, color: '#111827' },
  highlight: { ...base, color: '#fde047', opacity: 0.45 },
  pen: { ...base, color: '#dc2626', width: 2 },
  rect: { ...base, color: '#2563eb', width: 2 },
  ellipse: { ...base, color: '#2563eb', width: 2 },
  line: { ...base, color: '#2563eb', width: 2 },
  arrow: { ...base, color: '#dc2626', width: 2 },
  whiteout: { ...base, color: '#ffffff' },
});

const SVGNS = 'http://www.w3.org/2000/svg';
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, any> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, String(v));
  return e;
}

let measureCtx: CanvasRenderingContext2D | null = null;
export function measureText(a: Pick<TextAnn, 'text' | 'font' | 'size' | 'bold' | 'italic'>) {
  measureCtx ||= document.createElement('canvas').getContext('2d')!;
  const font = effectiveFont(a.font, a.text);
  measureCtx.font = `${a.italic && !isUrduFont(font) ? 'italic ' : ''}${a.bold ? 'bold ' : ''}${a.size}px ${FONT_CSS[font]}`;
  const lines = a.text.split('\n');
  const w = Math.max(a.size * 0.5, ...lines.map(l => measureCtx!.measureText(l).width));
  return { w: Math.ceil(w + 1), h: lines.length * a.size * METRICS[font].lh };
}

export class PageView {
  wrap = document.createElement('div');
  inner = document.createElement('div');
  canvas = document.createElement('canvas');
  svg = s('svg');
  annLayer = s('g');
  uiLayer = s('g');
  editLayer = s('g');
  label = document.createElement('div');
  renderedKey = '';
  visible = false;
  constructor(public page: PageRef) {
    this.wrap.className = 'page-wrap';
    this.inner.className = 'page';
    this.label.className = 'page-label';
    this.svg.setAttribute('class', 'overlay');
    this.svg.append(this.annLayer, this.uiLayer, this.editLayer);
    this.inner.append(this.canvas, this.svg);
    this.wrap.append(this.inner, this.label);
    this.wrap.dataset.pageId = page.id;
  }
  get rot() { return (this.page.baseRotation + this.page.rotation) % 360; }
}

type Drag =
  | { kind: 'move'; v: PageView; id: string; last: { x: number; y: number }; saved: boolean }
  | { kind: 'resize'; v: PageView; id: string; from: { x: number; y: number; w: number; h: number }; orig: Annotation; saved: boolean }
  | { kind: 'create'; v: PageView; ann: BoxAnn | LineAnn; start: { x: number; y: number } }
  | { kind: 'ink'; v: PageView; ann: InkAnn };

export class Viewer {
  tool: Tool = 'select';
  zoom = 1;
  selectedId: string | null = null;
  current = 0;
  styles = defaultStyles();
  onChange: () => void = () => {};

  private views = new Map<string, PageView>();
  edit = new EditMode(this);
  pageViews() { return [...this.views.values()]; }
  viewFor(pageId: string) { return this.views.get(pageId); }
  pagePoint(e: { clientX: number; clientY: number }, v: PageView) { return this.pt(e, v); }
  private pagesEl: HTMLElement;
  private observer: IntersectionObserver;
  private drag: Drag | null = null;
  private lastDown: { id: string; t: number } | null = null;
  private editor: { v: PageView; ann: TextAnn; isNew: boolean; fo: SVGForeignObjectElement; ta: HTMLTextAreaElement; anchorRight: number } | null = null;

  constructor(public root: HTMLElement, public store: DocStore) {
    this.pagesEl = root.querySelector('#pages') as HTMLElement;
    this.observer = new IntersectionObserver(entries => {
      for (const en of entries) {
        const v = this.views.get((en.target as HTMLElement).dataset.pageId!); if (!v) continue;
        v.visible = en.isIntersecting;
        if (v.visible) this.paint(v);
        else if (v.renderedKey) { v.canvas.width = 0; v.canvas.height = 0; v.renderedKey = ''; } // free memory
      }
    }, { root, rootMargin: '900px 0px' });
    store.subscribe(() => this.sync());
    let ticking = false;
    root.addEventListener('scroll', () => {
      if (ticking) return; ticking = true;
      requestAnimationFrame(() => { ticking = false; this.updateCurrent(); });
    });
    window.addEventListener('pointermove', e => { this.onMove(e); this.edit.onMove(e); });
    window.addEventListener('pointerup', e => { this.onUp(e); this.edit.onUp(); });
    window.addEventListener('pointercancel', e => { this.onUp(e); this.edit.onUp(); });
    root.addEventListener('wheel', e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });
  }

  // ---------- page list ----------
  sync() {
    const pages = this.store.pages;
    const ids = new Set(pages.map(p => p.id));
    for (const [id, v] of this.views) if (!ids.has(id)) { this.observer.unobserve(v.wrap); v.wrap.remove(); this.views.delete(id); }
    pages.forEach((page, i) => {
      let v = this.views.get(page.id);
      if (!v) {
        v = new PageView(page);
        v.svg.addEventListener('pointerdown', e => this.onDown(e, v!));
        v.svg.addEventListener('dblclick', e => (this.tool === 'edit' ? this.edit.onDouble(e, v!) : this.onDouble(e, v!)));
        v.svg.addEventListener('pointermove', e => { if (this.tool === 'edit') this.edit.onHover(e, v!); });
        v.svg.addEventListener('pointerleave', () => this.edit.onLeave(v!));
        this.views.set(page.id, v);
        this.observer.observe(v.wrap);
      }
      v.page = page;
      v.label.textContent = `${i + 1} / ${pages.length}`;
      if (this.pagesEl.children[i] !== v.wrap) this.pagesEl.insertBefore(v.wrap, this.pagesEl.children[i] || null);
      this.layout(v);
      this.drawOverlay(v);
      this.edit.draw(v);
      if (v.visible) this.paint(v);
    });
    if (this.selectedId && !this.store.findAnn(this.selectedId)) this.selectedId = null;
    if (this.editor && !this.views.has(this.editor.v.page.id)) this.editor = null;
    this.current = Math.min(this.current, Math.max(0, pages.length - 1));
    this.root.classList.toggle('has-doc', pages.length > 0);
    this.onChange();
  }

  private layout(v: PageView) {
    const W = v.page.width * this.zoom, H = v.page.height * this.zoom, r = v.rot;
    const side = r % 180 !== 0;
    v.wrap.style.width = `${side ? H : W}px`;
    v.wrap.style.height = `${side ? W : H}px`;
    v.inner.style.width = `${W}px`;
    v.inner.style.height = `${H}px`;
    v.inner.style.transform = `translate(-50%, -50%) rotate(${r}deg)`;
    v.svg.setAttribute('viewBox', `0 0 ${v.page.width} ${v.page.height}`);
  }

  private async paint(v: PageView) {
    const key = `${this.zoom}:${editsKey(v.page)}`;
    if (v.renderedKey === key) return;
    v.renderedKey = key;
    try { await renderPage(v.page, this.zoom, v.canvas); }
    catch (e) { v.renderedKey = ''; console.error(e); }
  }

  setZoom(z: number) {
    z = Math.min(5, Math.max(0.25, Math.round(z * 100) / 100));
    if (z === this.zoom) return;
    const ratio = this.root.scrollTop / Math.max(1, this.root.scrollHeight);
    this.zoom = z;
    for (const v of this.views.values()) this.layout(v);
    this.root.scrollTop = ratio * this.root.scrollHeight;
    for (const v of this.views.values()) if (v.visible) this.paint(v);
    this.onChange();
  }
  /** Fit the widest page to the window; `max` caps the zoom (opening a file uses a gentler cap). */
  fitWidth(max = 3) {
    const widest = Math.max(1, ...this.store.pages.map(p => ((p.baseRotation + p.rotation) % 180 ? p.height : p.width)));
    this.setZoom(Math.min(max, (this.root.clientWidth - 64) / widest));
  }

  private updateCurrent() {
    const top = this.root.getBoundingClientRect().top + this.root.clientHeight / 3;
    let idx = 0;
    this.store.pages.forEach((p, i) => { const r = this.views.get(p.id)!.wrap.getBoundingClientRect(); if (r.top <= top) idx = i; });
    if (idx !== this.current) { this.current = idx; this.onChange(); }
  }
  scrollToPage(i: number) {
    const p = this.store.pages[i]; if (!p) return;
    this.current = i;
    this.root.scrollTop += this.views.get(p.id)!.wrap.getBoundingClientRect().top - this.root.getBoundingClientRect().top - 16;
    this.onChange();
  }

  // ---------- drawing the overlay ----------
  drawOverlay(v: PageView) {
    const editingId = this.editor?.v === v ? this.editor.ann.id : null;
    v.annLayer.replaceChildren(...drawOrder(v.page.annotations).filter(a => a.id !== editingId).map(a => this.annNode(a)));
    v.uiLayer.replaceChildren();
    if (this.editor?.v === v && !v.svg.contains(this.editor.fo)) v.uiLayer.append(this.editor.fo);
    const sel = this.selectedId && v.page.annotations.find(a => a.id === this.selectedId);
    if (sel && !editingId) {
      const b = annBounds(sel), pad = 3 / this.zoom, hs = 9 / this.zoom;
      v.uiLayer.append(
        s('rect', { class: 'sel-box', x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, 'vector-effect': 'non-scaling-stroke' }),
        s('rect', { class: 'sel-handle', 'data-handle': 'se', x: b.x + b.w + pad - hs / 2, y: b.y + b.h + pad - hs / 2, width: hs, height: hs, 'vector-effect': 'non-scaling-stroke' }),
      );
    }
  }

  private annNode(a: Annotation): SVGGElement {
    const g = s('g', { 'data-id': a.id, class: `ann ann-${a.type}` });
    const hitStroke = (shape: SVGElement, w: number) => { const h = shape.cloneNode() as SVGElement; h.setAttribute('class', 'hit'); h.setAttribute('stroke-width', String(Math.max(w + 8, 10))); h.setAttribute('fill', 'none'); return h; };
    switch (a.type) {
      case 'text': {
        const font = effectiveFont(a.font, a.text), m = METRICS[font], rtl = isRtlText(a.text);
        const t = s('text', { x: a.x, 'font-family': FONT_CSS[font], 'font-size': a.size, fill: a.color, 'font-weight': a.bold ? 700 : 400, 'font-style': a.italic && !isUrduFont(font) ? 'italic' : 'normal', direction: rtl ? 'rtl' : 'ltr' });
        t.setAttribute('xml:space', 'preserve');
        // Right-to-left lines are right-aligned to the box's right edge (same rule as the PDF writer).
        a.text.split('\n').forEach((line, i) => {
          const sp = s('tspan', { x: rtl ? a.x + a.w : a.x, y: a.y + a.size * (m.base + m.lh * i) }); sp.textContent = line || ' '; t.append(sp);
        });
        g.append(s('rect', { class: 'hit-fill', x: a.x, y: a.y, width: a.w, height: a.h }), t);
        break;
      }
      case 'highlight': g.append(s('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: a.color, 'fill-opacity': a.opacity, style: 'mix-blend-mode:multiply' })); break;
      case 'whiteout': g.append(s('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: a.color })); break;
      case 'rect': {
        const r = s('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-opacity': a.opacity });
        g.append(hitStroke(r, a.width), r); break;
      }
      case 'ellipse': {
        const e = s('ellipse', { cx: a.x + a.w / 2, cy: a.y + a.h / 2, rx: a.w / 2, ry: a.h / 2, fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-opacity': a.opacity });
        g.append(hitStroke(e, a.width), e); break;
      }
      case 'line': case 'arrow': {
        const l = s('line', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round' });
        g.append(hitStroke(l, a.width), l);
        if (a.type === 'arrow') g.append(s('path', { d: arrowHead(a.x1, a.y1, a.x2, a.y2, a.width), fill: a.color }));
        break;
      }
      case 'ink': {
        const p = a.points; let d = `M ${p[0]} ${p[1]}`;
        for (let i = 2; i < p.length; i += 2) d += ` L ${p[i]} ${p[i + 1]}`;
        if (p.length === 2) d += ` L ${p[0] + 0.01} ${p[1]}`;
        const path = s('path', { d, fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
        g.append(hitStroke(path, a.width), path); break;
      }
      case 'image': {
        const asset = this.assetsLookup(a.assetId);
        g.append(s('image', { href: asset?.dataUrl, x: a.x, y: a.y, width: a.w, height: a.h, preserveAspectRatio: 'none' }), s('rect', { class: 'hit-fill', x: a.x, y: a.y, width: a.w, height: a.h }));
        break;
      }
    }
    return g;
  }
  private assetsLookup(id: string): Asset | undefined { return this.store.assets.get(id); }

  // ---------- pointer handling ----------
  /** Screen point -> page point (unrotated, top-left origin, points). */
  private pt(e: { clientX: number; clientY: number }, v: PageView) {
    const r = v.wrap.getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2)) / this.zoom, dy = (e.clientY - (r.top + r.height / 2)) / this.zoom;
    const rad = -v.rot * Math.PI / 180, c = Math.cos(rad), sn = Math.sin(rad);
    return { x: dx * c - dy * sn + v.page.width / 2, y: dx * sn + dy * c + v.page.height / 2 };
  }

  select(id: string | null) {
    this.selectedId = id;
    for (const v of this.views.values()) this.drawOverlay(v);
    this.onChange();
  }

  private onDown(e: PointerEvent, v: PageView) {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (this.editor && this.editor.fo.contains(target)) return; // typing inside the editor
    if (this.tool === 'edit') {
      if (this.editor) this.commitText();
      this.current = this.store.pages.findIndex(pg => pg.id === v.page.id);
      if (!this.edit.editing || !(target as Element).closest?.('foreignObject')) e.preventDefault();
      this.edit.onDown(e, v);
      return;
    }
    const p = this.pt(e, v);
    const annEl = target.closest('[data-id]') as SVGGElement | null;
    const annId = annEl?.dataset.id ?? null;
    const hadEditor = !!this.editor;
    if (this.editor) this.commitText();
    this.current = this.store.pages.findIndex(pg => pg.id === v.page.id);
    e.preventDefault();

    if (this.tool === 'select') {
      if (target.closest('[data-handle]') && this.selectedId) {
        const ann = v.page.annotations.find(a => a.id === this.selectedId);
        if (ann) this.drag = { kind: 'resize', v, id: ann.id, from: annBounds(ann), orig: structuredClone(ann), saved: false };
      } else if (annId) {
        const hit = v.page.annotations.find(a => a.id === annId);
        const now = performance.now(), dbl = this.lastDown?.id === annId && now - this.lastDown.t < 450;
        this.lastDown = { id: annId, t: now };
        if (dbl && hit?.type === 'text') { this.lastDown = null; this.openEditor(v, hit, false); return; }
        this.select(annId);
        this.drag = { kind: 'move', v, id: annId, last: p, saved: false };
      } else this.select(null);
      return;
    }
    if (this.tool === 'text') {
      const hit = annId && v.page.annotations.find(a => a.id === annId);
      if (hit && hit.type === 'text') { this.openEditor(v, hit, false); return; }
      if (hadEditor) return; // first click outside only closes the open editor
      const st = this.styles.text;
      const ann: TextAnn = { id: uid('a'), type: 'text', x: p.x, y: p.y - st.size * 0.6, w: 0, h: 0, text: '', font: st.font, fontLabel: st.fontLabel, size: st.size, color: st.color, bold: st.bold, italic: st.italic };
      this.openEditor(v, ann, true);
      return;
    }
    if (this.tool === 'pen') {
      const st = this.styles.pen;
      this.drag = { kind: 'ink', v, ann: { id: uid('a'), type: 'ink', points: [p.x, p.y], color: st.color, width: st.width } };
      this.preview(); return;
    }
    const st = this.styles[this.tool];
    if (this.tool === 'line' || this.tool === 'arrow') {
      this.drag = { kind: 'create', v, start: p, ann: { id: uid('a'), type: this.tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: st.color, width: st.width } };
    } else {
      this.drag = { kind: 'create', v, start: p, ann: { id: uid('a'), type: this.tool as BoxAnn['type'], x: p.x, y: p.y, w: 0, h: 0, color: st.color, width: st.width, opacity: st.opacity } };
    }
  }

  private onDouble(e: MouseEvent, v: PageView) {
    if (this.tool !== 'select') return;
    if (this.editor) return;
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-id]') as SVGGElement | null;
    const id = under?.dataset.id;
    const ann = id && v.page.annotations.find(a => a.id === id);
    if (ann && ann.type === 'text') this.openEditor(v, ann, false);
  }

  private onMove(e: PointerEvent) {
    const d = this.drag; if (!d) return;
    const p = this.pt(e, d.v);
    if (d.kind === 'move') {
      const dx = p.x - d.last.x, dy = p.y - d.last.y;
      if (!d.saved) { if (Math.hypot(dx, dy) * this.zoom < 3) return; this.store.checkpoint(); d.saved = true; }
      const ann = d.v.page.annotations.find(a => a.id === d.id)!;
      moveAnn(ann, dx, dy); d.last = p;
      this.drawOverlay(d.v);
    } else if (d.kind === 'resize') {
      if (!d.saved) { this.store.checkpoint(); d.saved = true; }
      const ann = d.v.page.annotations.find(a => a.id === d.id)!;
      const f = d.from;
      let w = Math.max(4, p.x - f.x), h = Math.max(4, p.y - f.y);
      if (ann.type === 'image' || ann.type === 'text') { const k = Math.max(w / (f.w || 1), h / (f.h || 1)); w = f.w * k; h = f.h * k; }
      if (ann.type === 'text') {
        const o = d.orig as TextAnn;
        ann.size = Math.max(4, Math.round(o.size * (h / (f.h || 1)) * 2) / 2);
        Object.assign(ann, measureText(ann));
      } else {
        Object.assign(ann, structuredClone(d.orig));
        resizeAnn(ann, f, { x: f.x, y: f.y, w, h });
      }
      this.drawOverlay(d.v);
    } else if (d.kind === 'create') {
      const a = d.ann;
      if (a.type === 'line' || a.type === 'arrow') {
        a.x2 = p.x; a.y2 = p.y;
        if (e.shiftKey) { // snap to 45 degrees
          const ang = Math.round(Math.atan2(p.y - a.y1, p.x - a.x1) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(p.x - a.x1, p.y - a.y1);
          a.x2 = a.x1 + len * Math.cos(ang); a.y2 = a.y1 + len * Math.sin(ang);
        }
      } else {
        const b = a as BoxAnn;
        b.x = Math.min(d.start.x, p.x); b.y = Math.min(d.start.y, p.y);
        b.w = Math.abs(p.x - d.start.x); b.h = Math.abs(p.y - d.start.y);
        if (e.shiftKey && b.type !== 'highlight') { const m = Math.max(b.w, b.h); b.w = b.h = m; }
      }
      this.preview();
    } else if (d.kind === 'ink') {
      const pts = d.ann.points, lx = pts[pts.length - 2], ly = pts[pts.length - 1];
      if (Math.hypot(p.x - lx, p.y - ly) * this.zoom >= 1.5) { pts.push(+p.x.toFixed(2), +p.y.toFixed(2)); this.preview(); }
    }
  }

  private preview() {
    const d = this.drag; if (!d || (d.kind !== 'create' && d.kind !== 'ink')) return;
    this.drawOverlay(d.v);
    d.v.uiLayer.append(this.annNode(d.ann));
  }

  private onUp(_e: PointerEvent) {
    const d = this.drag; if (!d) return;
    this.drag = null;
    if (d.kind === 'move' || d.kind === 'resize') { if (d.saved) this.store.changed(); return; }
    const ann = d.ann;
    let ok = true;
    if (ann.type === 'line' || ann.type === 'arrow') ok = Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1) * this.zoom > 4;
    else if (ann.type !== 'ink') ok = (ann as BoxAnn).w * this.zoom > 3 && (ann as BoxAnn).h * this.zoom > 3;
    if (!ok) { this.drawOverlay(d.v); return; }
    const pageId = d.v.page.id;
    this.store.apply(pages => pages.find(p => p.id === pageId)!.annotations.push(ann));
  }

  // ---------- text editing ----------
  private openEditor(v: PageView, original: TextAnn, isNew: boolean) {
    if (this.editor) this.commitText();
    this.selectedId = isNew ? null : original.id;
    const ann: TextAnn = { ...original }; // edit a copy; the store changes only on commit
    // Left-to-right text grows from the left edge, right-to-left (Urdu) text from the right edge.
    const anchorLeft = ann.x, anchorRight = isNew ? ann.x : ann.x + ann.w;
    const fo = s('foreignObject', { x: ann.x, y: ann.y, width: 10, height: 10 });
    const ta = document.createElement('textarea');
    ta.className = 'text-editor';
    ta.value = ann.text; ta.spellcheck = true; ta.dir = 'auto'; ta.setAttribute('aria-label', 'Text');
    const pad = () => ann.size + 6;
    const fit = () => {
      const text = ta.value || ' ';
      const font = effectiveFont(ann.font, text), m = METRICS[font], rtl = isRtlText(text);
      Object.assign(ta.style, {
        fontFamily: FONT_CSS[font], fontSize: `${ann.size}px`, lineHeight: String(m.lh), color: ann.color,
        fontWeight: ann.bold ? '700' : '400', fontStyle: ann.italic && !isUrduFont(font) ? 'italic' : 'normal',
        textAlign: rtl ? 'right' : 'left',
      });
      const mm = measureText({ ...ann, text });
      const w = mm.w + pad();
      ta.style.width = `${w}px`; ta.style.height = `${mm.h + 4}px`;
      const left = rtl ? anchorRight - mm.w - pad() + 1 : anchorLeft - 1;
      fo.setAttribute('x', String(left));
      fo.setAttribute('y', String(ann.y - ann.size * (m.editor - m.base) - 1));
      fo.setAttribute('width', String(w + 4));
      fo.setAttribute('height', String(mm.h + ann.size * 2));
    };
    ta.addEventListener('input', () => {
      // Typing Urdu into a Latin-font box switches the box (and the next ones) to the Urdu font.
      if (!isUrduFont(ann.font) && hasArabicScript(ta.value)) {
        ann.font = 'Nastaliq'; ann.fontLabel = undefined; this.styles.text.font = 'Nastaliq'; this.styles.text.fontLabel = undefined; this.onChange();
      }
      fit();
    });
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.commitText(); }
    });
    ta.addEventListener('blur', () => setTimeout(() => { if (this.editor?.ta === ta) this.commitText(); }, 0));
    fo.append(ta);
    this.editor = { v, ann, isNew, fo, ta, anchorRight };
    this.drawOverlay(v);
    fit();
    const focus = () => { if (this.editor?.ta === ta && document.activeElement !== ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } };
    focus(); requestAnimationFrame(focus); setTimeout(focus, 50);
    this.onChange();
  }

  /** Apply a style change to the text box being edited (from the toolbar). */
  styleEditor(patch: Partial<TextAnn>) {
    if (!this.editor) return false;
    Object.assign(this.editor.ann, patch);
    this.editor.ta.dispatchEvent(new Event('input'));
    return true;
  }
  get editing() { return !!this.editor; }
  get editorAnn(): TextAnn | null { return this.editor?.ann ?? null; }

  commitText() {
    const ed = this.editor; if (!ed) return;
    this.editor = null;
    ed.fo.remove();
    const text = ed.ta.value.replace(/\s+$/, '');
    const pageId = ed.v.page.id;
    const finalAnn = (): TextAnn => {
      const m = measureText({ ...ed.ann, text });
      const x = isRtlText(text) ? ed.anchorRight - m.w : ed.ann.x;
      return { ...ed.ann, text, x, ...m };
    };
    if (ed.isNew) {
      if (text) {
        const ann = finalAnn();
        this.store.apply(pages => pages.find(p => p.id === pageId)!.annotations.push(ann));
        this.select(ann.id);
      } else this.drawOverlay(ed.v);
    } else {
      const before = this.store.findAnn(ed.ann.id)?.ann as TextAnn | undefined;
      const styleChanged = before && (['font', 'fontLabel', 'size', 'color', 'bold', 'italic'] as const).some(k => before[k] !== ed.ann[k]);
      if (before && (text !== before.text || styleChanged)) {
        this.store.apply(pages => {
          const page = pages.find(p => p.id === pageId)!;
          const i = page.annotations.findIndex(a => a.id === ed.ann.id);
          if (!text) page.annotations.splice(i, 1);
          else page.annotations[i] = finalAnn();
        });
      } else this.drawOverlay(ed.v);
    }
    this.onChange();
  }

  // ---------- commands used by the app ----------
  selected(): Annotation | null { return this.selectedId ? this.store.findAnn(this.selectedId)?.ann ?? null : null; }

  deleteSelected() {
    const id = this.selectedId; if (!id) return;
    this.store.apply(pages => { for (const p of pages) p.annotations = p.annotations.filter(a => a.id !== id); });
    this.select(null);
  }
  nudge(dx: number, dy: number) {
    const id = this.selectedId; if (!id) return;
    this.store.apply(() => { const f = this.store.findAnn(id); if (f) moveAnn(f.ann, dx, dy); });
  }
  /** Change style props of the selected annotation. */
  restyleSelected(patch: Record<string, any>) {
    const id = this.selectedId; if (!id) return;
    this.store.apply(() => {
      const f = this.store.findAnn(id); if (!f) return;
      const a: any = f.ann;
      for (const [k, v] of Object.entries(patch)) if (k in a || k === 'fontLabel') a[k] = v;
      if (a.type === 'text') Object.assign(a, measureText(a));
    });
  }
  /** Put an image on the current page, centred, and select it. */
  placeImage(asset: Asset, maxWidth: number) {
    const page = this.store.pages[this.current]; if (!page) return;
    const w = Math.min(maxWidth, asset.w, page.width * 0.8), h = w * asset.h / asset.w;
    const ann: ImageAnn = { id: uid('a'), type: 'image', assetId: asset.id, w, h, x: (page.width - w) / 2, y: (page.height - h) / 2 };
    this.store.apply(pages => pages.find(p => p.id === page.id)!.annotations.push(ann));
    this.tool = 'select';
    this.select(ann.id);
  }
  setTool(t: Tool) {
    if (this.editor) this.commitText();
    if (this.tool === 'edit' && t !== 'edit') this.edit.clear();
    this.tool = t;
    this.root.dataset.tool = t;
    if (t === 'edit') this.edit.redrawAll();
    if (t !== 'select') this.select(null); else this.onChange();
  }
}
