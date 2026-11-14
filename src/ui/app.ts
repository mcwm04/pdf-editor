// App shell: toolbar, properties bar, page sidebar, file operations and dialogs.
import { zipSync } from 'fflate';
import { Asset, DocStore, PageRef, chunkEvery, parseRanges, uid, Annotation } from '../core/model';
import { blankPage, loadPdf, thumbnail, sources } from '../core/render';
import { exportPdf } from '../core/export';
import { platform, PickedFile } from '../platform';
import { Viewer, Tool } from './viewer';
import { FONT_LABEL } from '../core/fonts';
import { documentFonts, DocFont } from '../core/docfonts';
import { askPassword, busy, confirmBox, el, modal, toast } from './dialogs';
import { icon } from './icons';
import { signatureDialog } from './signature';

const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: 'select', label: 'Select', key: 'V', icon: 'select' },
  { id: 'edit', label: 'Edit PDF', key: 'X', icon: 'editpdf' },
  { id: 'text', label: 'Text', key: 'T', icon: 'text' },
  { id: 'highlight', label: 'Highlight', key: 'H', icon: 'highlight' },
  { id: 'pen', label: 'Draw', key: 'P', icon: 'pen' },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: 'rect' },
  { id: 'ellipse', label: 'Ellipse', key: 'E', icon: 'ellipse' },
  { id: 'line', label: 'Line', key: 'L', icon: 'line' },
  { id: 'arrow', label: 'Arrow', key: 'A', icon: 'arrow' },
  { id: 'whiteout', label: 'Whiteout', key: 'W', icon: 'whiteout' },
];
const TYPE_TO_TOOL: Record<Annotation['type'], Tool | null> = {
  text: 'text', highlight: 'highlight', ink: 'pen', rect: 'rect', ellipse: 'ellipse', line: 'line', arrow: 'arrow', whiteout: 'whiteout', image: null,
};
type Prop = 'color' | 'width' | 'font' | 'fontLabel' | 'size' | 'bold' | 'italic' | 'opacity';
const PROPS_FOR: Record<string, Prop[]> = {
  text: ['color', 'font', 'size', 'bold', 'italic'], highlight: ['color', 'opacity'], pen: ['color', 'width'],
  rect: ['color', 'width', 'opacity'], ellipse: ['color', 'width', 'opacity'], line: ['color', 'width'], arrow: ['color', 'width'],
  whiteout: ['color'], select: [], image: [], edit: [],
};

export function startApp() {
  const store = new DocStore();
  const viewerEl = document.getElementById('viewer')!;
  const viewer = new Viewer(viewerEl, store);
  let dirty = false, quiet = false;
  store.subscribe(() => { if (!quiet) dirty = true; });

  // ---------- top bar ----------
  const topbar = document.getElementById('topbar')!;
  const btn = (name: string, label: string, onclick: () => void, extra: Record<string, any> = {}) =>
    el('button', { class: 'icon-btn', title: label, 'aria-label': label, html: icon(name), onclick, ...extra });
  const undoBtn = btn('undo', 'Undo (Ctrl+Z)', () => store.undo());
  const redoBtn = btn('redo', 'Redo (Ctrl+Y)', () => store.redo());
  const saveBtn = el('button', { class: 'btn primary', title: 'Download the edited PDF (Ctrl+S)', html: `${icon('save', 16)}<span>Download</span>`, onclick: () => save() });
  const toolBtns = new Map<Tool, HTMLButtonElement>();
  const toolGroup = el('div', { class: 'group tools', role: 'toolbar', 'aria-label': 'Tools' });
  for (const t of TOOLS) {
    const b = el('button', { class: 'tool-btn', title: `${t.label} (${t.key})`, 'aria-label': t.label, 'aria-pressed': 'false', html: `${icon(t.icon)}<span>${t.label}</span>`, onclick: () => viewer.setTool(t.id) }) as HTMLButtonElement;
    if (t.id === 'edit') b.classList.add('edit-pdf');
    toolBtns.set(t.id, b); toolGroup.append(b);
  }
  toolGroup.append(
    el('button', { class: 'tool-btn', title: 'Insert image', 'aria-label': 'Insert image', html: `${icon('image')}<span>Image</span>`, onclick: () => insertImage() }),
    el('button', { class: 'tool-btn', title: 'Add signature', 'aria-label': 'Add signature', html: `${icon('sign')}<span>Sign</span>`, onclick: () => addSignature() }),
  );
  const zoomLabel = el('button', { class: 'zoom-label', title: 'Fit width (Ctrl+0)', onclick: () => viewer.fitWidth() }, '100%');
  const pageLabel = el('span', { class: 'page-indicator' }, '');
  topbar.append(
    el('div', { class: 'brand' }, el('span', { class: 'logo', html: icon('file', 18) }), el('span', {}, 'PDF Editor')),
    el('div', { class: 'group' },
      el('button', { class: 'btn', title: 'Open a PDF (Ctrl+O)', html: `${icon('open', 16)}<span>Open</span>`, onclick: () => openDialog() }),
      btn('insert', 'Insert pages from another PDF', () => insertDialog()),
    ),
    el('div', { class: 'group' }, undoBtn, redoBtn),
    toolGroup,
    el('div', { class: 'spacer' }),
    el('div', { class: 'group' }, btn('zoomOut', 'Zoom out', () => viewer.setZoom(viewer.zoom / 1.2)), zoomLabel, btn('zoomIn', 'Zoom in', () => viewer.setZoom(viewer.zoom * 1.2)), pageLabel),
    saveBtn,
  );

  // ---------- properties bar ----------
  const propbar = document.getElementById('propbar')!;
  const color = el('input', { type: 'color', class: 'color', 'aria-label': 'Colour', title: 'Colour' }) as HTMLInputElement;
  const width = el('select', { class: 'input small', 'aria-label': 'Line width', title: 'Line width' }, ...[1, 2, 3, 4, 6, 8, 12].map(w => el('option', { value: w }, `${w} pt`))) as HTMLSelectElement;
  const font = el('select', { class: 'input small', 'aria-label': 'Font', title: 'Font' }) as HTMLSelectElement;
  let docFonts: DocFont[] = [], docFontsKey = '';
  /** Built-in fonts, plus a group with the fonts already used in the open document(s). */
  function rebuildFontList() {
    const std = el('optgroup', { label: 'Built-in fonts' }, ...Object.entries(FONT_LABEL).map(([f, label]) => el('option', { value: f }, label)));
    font.replaceChildren(std);
    if (docFonts.length) {
      font.prepend(el('optgroup', { label: 'Fonts in this document' }, ...docFonts.map(d =>
        el('option', { value: `doc:${d.family}`, title: `Saved with the closest built-in font: ${FONT_LABEL[d.std]}` }, d.family))));
    }
  }
  function updateDocFonts() {
    const fbs = new Map(Array.from(sources.values(), s => [s.id, s.fonts] as const));
    docFonts = documentFonts(store.pages, fbs);
    const key = docFonts.map(d => d.family).join('|');
    if (key !== docFontsKey) { docFontsKey = key; rebuildFontList(); }
  }
  rebuildFontList();
  const size = el('input', { type: 'number', class: 'input tiny-num', min: 4, max: 200, step: 1, 'aria-label': 'Font size', title: 'Font size' }) as HTMLInputElement;
  const bold = el('button', { class: 'icon-btn toggle', title: 'Bold', 'aria-label': 'Bold', 'aria-pressed': 'false', html: icon('bold', 16) }) as HTMLButtonElement;
  const italic = el('button', { class: 'icon-btn toggle', title: 'Italic', 'aria-label': 'Italic', 'aria-pressed': 'false', html: icon('italic', 16) }) as HTMLButtonElement;
  const opacity = el('input', { type: 'range', min: 0.1, max: 1, step: 0.05, class: 'range', 'aria-label': 'Opacity', title: 'Opacity' }) as HTMLInputElement;
  const swatches = el('div', { class: 'swatches' }, ...['#111827', '#dc2626', '#2563eb', '#16a34a', '#f59e0b', '#fde047', '#ffffff'].map(c =>
    el('button', { class: 'swatch', style: `background:${c}`, title: c, 'aria-label': `Colour ${c}`, onmousedown: (e: Event) => e.preventDefault(), onclick: () => setProp('color', c) })));
  const deleteBtn = el('button', { class: 'btn small danger-ghost', html: `${icon('trash', 15)}<span>Delete</span>`, onclick: () => (viewer.tool === 'edit' ? viewer.edit.deleteSelected() : viewer.deleteSelected()) });
  const editTextBtn = el('button', { class: 'btn small', html: `${icon('text', 15)}<span>Change text</span>`, onclick: () => viewer.edit.editSelectedText() });
  const ctxLabel = el('span', { class: 'ctx-label' });
  const hint = el('span', { class: 'hint' });
  const wrapProp = (p: Prop, ...nodes: Node[]) => el('label', { class: 'prop', 'data-prop': p }, ...nodes);
  propbar.append(ctxLabel,
    wrapProp('color', color, swatches), wrapProp('font', font), wrapProp('size', size), wrapProp('bold', bold, italic),
    wrapProp('width', width), wrapProp('opacity', el('span', { class: 'muted' }, 'Opacity'), opacity),
    editTextBtn, deleteBtn, el('div', { class: 'spacer' }), hint);
  for (const b of [bold, italic]) b.addEventListener('mousedown', e => e.preventDefault()); // keep the text editor focused

  const contextKind = (): string => {
    if (viewer.tool === 'edit') return 'edit';
    if (viewer.editing) return 'text';
    const sel = viewer.selected();
    if (sel) return sel.type === 'ink' ? 'pen' : sel.type;
    return viewer.tool;
  };
  const currentValues = (): Record<string, any> => {
    if (viewer.editing) return viewer.editorAnn as any;
    const sel = viewer.selected();
    if (sel) return sel as any;
    const k = contextKind() as Tool;
    return viewer.styles[k] || viewer.styles.select;
  };
  function setProp(p: Prop, value: any) {
    const kind = contextKind();
    const tool = (kind in viewer.styles ? kind : null) as Tool | null;
    if (tool) (viewer.styles[tool] as any)[p] = value;
    if (viewer.editing) viewer.styleEditor({ [p]: value } as any);
    else if (viewer.selected()) viewer.restyleSelected({ [p]: value });
    refresh();
  }
  color.oninput = () => setProp('color', color.value);
  width.onchange = () => setProp('width', +width.value);
  font.onchange = () => {
    if (font.value.startsWith('doc:')) {
      const d = docFonts.find(x => `doc:${x.family}` === font.value);
      if (!d) return;
      setProp('font', d.std); setProp('fontLabel', d.family);
      if (d.bold) setProp('bold', true);
      if (d.italic) setProp('italic', true);
    } else { setProp('font', font.value); setProp('fontLabel', undefined); }
  };
  size.onchange = () => { const v = Math.max(4, Math.min(200, +size.value || 12)); setProp('size', v); };
  size.addEventListener('keydown', e => { if (e.key === 'Enter') size.blur(); });
  bold.onclick = () => setProp('bold', bold.getAttribute('aria-pressed') !== 'true');
  italic.onclick = () => setProp('italic', italic.getAttribute('aria-pressed') !== 'true');
  opacity.onchange = () => setProp('opacity', +opacity.value);

  const HINTS: Record<string, string> = {
    select: 'Click an item to select it, drag to move, drag the corner to resize. Double-click text to edit.',
    text: 'Click on the page to type. Urdu works too: type in Urdu or pick an Urdu font. Ctrl+Enter or Esc to finish.',
    highlight: 'Drag over text to highlight it.',
    pen: 'Draw freely with the mouse or a pen.',
    rect: 'Drag to draw. Hold Shift for a square.', ellipse: 'Drag to draw. Hold Shift for a circle.',
    line: 'Drag to draw. Hold Shift to snap to 45°.', arrow: 'Drag to draw. Hold Shift to snap to 45°.',
    whiteout: 'Drag to cover content with a white box. Then use Text to type over it.',
    edit: 'Click text, images or shapes that are already in the PDF. Drag to move, double-click text to change it, Delete to remove.',
  };

  // ---------- sidebar ----------
  const sidebar = document.getElementById('sidebar')!;
  const pageCount = el('span', { class: 'muted' });
  const thumbs = el('div', { class: 'thumbs', role: 'list' });
  sidebar.append(
    el('div', { class: 'side-head' }, el('strong', {}, 'Pages'), pageCount),
    el('div', { class: 'side-actions' },
      btn('blank', 'Add blank page after current', () => addBlank()),
      btn('rotate', 'Rotate current page', () => rotatePage(viewer.current, 90)),
      btn('trash', 'Delete current page', () => deletePage(viewer.current)),
      btn('merge', 'Merge PDFs', () => mergeDialog()),
      btn('split', 'Split / extract pages', () => splitDialog()),
    ),
    thumbs,
  );
  let dragFrom = -1;
  function drawThumbs() {
    const pages = store.pages;
    pageCount.textContent = pages.length ? `${pages.length}` : '';
    const items = pages.map((p, i) => {
      const img = el('img', { alt: `Page ${i + 1}`, draggable: 'false' }) as HTMLImageElement;
      img.style.transform = `rotate(${(p.baseRotation + p.rotation) % 360}deg)`;
      thumbnail(p).then(u => { img.src = u; }).catch(() => {});
      const marks = p.annotations.length ? el('span', { class: 'thumb-badge', title: `${p.annotations.length} edits` }, String(p.annotations.length)) : '';
      const item = el('div', { class: `thumb${i === viewer.current ? ' current' : ''}`, role: 'listitem', draggable: 'true', 'data-i': i, title: `Page ${i + 1}. Drag to reorder.` },
        el('div', { class: 'thumb-img' }, img), el('div', { class: 'thumb-foot' }, el('span', {}, String(i + 1)), marks,
          el('span', { class: 'thumb-tools' },
            el('button', { class: 'icon-btn tiny', title: 'Rotate', 'aria-label': `Rotate page ${i + 1}`, html: icon('rotate', 14), onclick: (e: Event) => { e.stopPropagation(); rotatePage(i, 90); } }),
            el('button', { class: 'icon-btn tiny', title: 'Delete', 'aria-label': `Delete page ${i + 1}`, html: icon('trash', 14), onclick: (e: Event) => { e.stopPropagation(); deletePage(i); } }))));
      item.addEventListener('click', () => viewer.scrollToPage(i));
      item.addEventListener('dragstart', e => { dragFrom = i; e.dataTransfer!.effectAllowed = 'move'; e.dataTransfer!.setData('text/plain', String(i)); item.classList.add('dragging'); });
      item.addEventListener('dragend', () => { item.classList.remove('dragging'); thumbs.querySelectorAll('.drop-before,.drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after')); });
      item.addEventListener('dragover', e => {
        if (dragFrom < 0) return; e.preventDefault();
        const r = item.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        item.classList.toggle('drop-after', after); item.classList.toggle('drop-before', !after);
      });
      item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
      item.addEventListener('drop', e => {
        if (dragFrom < 0) return; e.preventDefault(); e.stopPropagation();
        const r = item.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        let to = i + (after ? 1 : 0); const from = dragFrom; dragFrom = -1;
        if (to > from) to--;
        if (to !== from) movePage(from, to);
      });
      return item;
    });
    thumbs.replaceChildren(...items);
  }
  function markCurrentThumb() {
    thumbs.querySelectorAll('.thumb').forEach((n, i) => n.classList.toggle('current', i === viewer.current));
    const cur = thumbs.children[viewer.current] as HTMLElement | undefined;
    if (cur) { const r = cur.getBoundingClientRect(), sr = thumbs.getBoundingClientRect(); if (r.top < sr.top || r.bottom > sr.bottom) cur.scrollIntoView({ block: 'nearest' }); }
  }

  // ---------- empty state ----------
  const empty = document.getElementById('empty')!;
  empty.append(el('div', { class: 'empty-card' },
    el('div', { class: 'empty-icon', html: icon('file', 40) }),
    el('h1', {}, 'Edit a PDF'),
    el('p', {}, 'Drop a PDF here, or open one from your device. Your file never leaves this device.'),
    el('div', { class: 'row center' },
      el('button', { class: 'btn primary big', html: `${icon('open', 18)}<span>Open PDF</span>`, onclick: () => openDialog() }),
      el('button', { class: 'btn big', html: `${icon('merge', 18)}<span>Merge PDFs</span>`, onclick: () => mergeDialog() }),
      el('button', { class: 'btn big', html: `${icon('blank', 18)}<span>Blank document</span>`, onclick: () => { quiet = true; store.reset([blankPage()], 'document.pdf'); quiet = false; dirty = false; viewer.fitWidth(1.3); } }),
    ),
    el('ul', { class: 'features' }, ...['Add text, highlights, drawings, shapes and images', 'Sign with a drawn, typed or uploaded signature',
      'Rotate, delete, reorder and insert pages', 'Merge several PDFs, or split one into parts'].map(t => el('li', {}, t)))));

  // ---------- refresh UI state ----------
  let lastPagesRef: PageRef[] | null = null, lastLen = -1, lastCurrent = -1;
  function refresh() {
    undoBtn.disabled = !store.canUndo; redoBtn.disabled = !store.canRedo;
    saveBtn.disabled = !store.pages.length;
    zoomLabel.textContent = `${Math.round(viewer.zoom * 100)}%`;
    pageLabel.textContent = store.pages.length ? `Page ${viewer.current + 1} of ${store.pages.length}` : '';
    for (const [id, b] of toolBtns) { const on = viewer.tool === id; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
    const kind = contextKind(), props = PROPS_FOR[kind] || [];
    const sel = viewer.selected();
    propbar.querySelectorAll<HTMLElement>('.prop').forEach(p => { p.style.display = props.includes(p.dataset.prop as Prop) ? '' : 'none'; });
    deleteBtn.style.display = sel && !viewer.editing ? '' : 'none';
    editTextBtn.style.display = 'none';
    const nameOf: Record<string, string> = { ink: 'Drawing', pen: 'Draw', rect: 'Rectangle', image: 'Image', whiteout: 'Whiteout' };
    ctxLabel.textContent = sel && !viewer.editing ? `Selected: ${nameOf[sel.type] || sel.type[0].toUpperCase() + sel.type.slice(1)}` : (TOOLS.find(t => t.id === viewer.tool)?.label || '');
    hint.textContent = store.pages.length ? (sel && !viewer.editing ? 'Delete key removes it. Arrow keys nudge it.' : HINTS[viewer.tool] || '') : '';
    if (viewer.tool === 'edit') {
      const es = viewer.edit.selected();
      deleteBtn.style.display = es && !viewer.edit.editing ? '' : 'none';
      editTextBtn.style.display = es?.o.kind === 'text' && !viewer.edit.editing ? '' : 'none';
      if (es) {
        const f = es.o.font;
        ctxLabel.textContent = es.o.kind === 'text' ? `Selected: Text · ${f?.baseFont || 'unknown font'} ${Math.round((es.o.size ?? 0) * 10) / 10} pt` : `Selected: ${es.o.label}`;
        hint.textContent = es.o.kind === 'text' ? 'Drag to move. Double-click or Enter to change the words. Delete removes it from the PDF.' : 'Drag to move, drag the corner to resize (Shift keeps the shape). Delete removes it from the PDF.';
      } else ctxLabel.textContent = 'Edit PDF';
    }
    const v = currentValues();
    if (v.color) color.value = v.color.length === 7 ? v.color : '#000000';
    if (v.width != null) width.value = String(v.width);
    if (v.font) {
      const label = v.fontLabel && docFonts.some(d => d.family === v.fontLabel) ? `doc:${v.fontLabel}` : v.font;
      font.value = label;
    }
    if (v.size != null && document.activeElement !== size) size.value = String(v.size);
    bold.setAttribute('aria-pressed', String(!!v.bold)); italic.setAttribute('aria-pressed', String(!!v.italic));
    if (v.opacity != null) opacity.value = String(v.opacity);
    updateDocFonts();
    if (store.pages !== lastPagesRef || store.pages.length !== lastLen) { lastPagesRef = store.pages; lastLen = store.pages.length; drawThumbs(); }
    if (viewer.current !== lastCurrent) { lastCurrent = viewer.current; markCurrentThumb(); }
    document.title = store.pages.length ? `${dirty ? '• ' : ''}${store.fileName} – PDF Editor` : 'PDF Editor';
  }
  viewer.onChange = refresh;
  // Thumbnails also need a redraw when annotations change in place (same array).
  store.subscribe(() => { drawThumbs(); lastCurrent = -1; refresh(); });
  viewer.setTool('select');
  refresh();

  // ---------- file operations ----------
  async function loadFiles(files: PickedFile[]): Promise<{ pages: PageRef[]; names: string[] }> {
    const pages: PageRef[] = [], names: string[] = [];
    for (const f of files) {
      try { const r = await loadPdf(f.bytes, f.name, askPassword); pages.push(...r.pages); names.push(f.name); }
      catch (e: any) { toast(e.message || String(e), 'error', 6000); }
    }
    return { pages, names };
  }
  async function openFiles(files: PickedFile[]) {
    const pdfs = files.filter(f => /\.pdf$/i.test(f.name) || isPdf(f.bytes));
    if (!pdfs.length) { toast('Please choose a PDF file', 'error'); return; }
    if (store.pages.length && dirty && !(await confirmBox('Open another file?', 'Your current edits have not been downloaded and will be lost.', 'Open anyway', true))) return;
    const b = busy('Opening…');
    try {
      const { pages, names } = await loadFiles(pdfs);
      if (!pages.length) return;
      quiet = true; store.reset(pages, names[0]); quiet = false; dirty = false;
      viewer.selectedId = null; viewer.current = 0;
      viewer.fitWidth(1.3); viewerEl.scrollTop = 0;
      refresh();
      if (names.length > 1) toast(`Opened ${names.length} files as one document`, 'ok');
    } finally { b.done(); }
  }
  async function openDialog() { const files = await platform.openFiles('application/pdf,.pdf', true); if (files.length) openFiles(files); }

  async function insertFiles(files: PickedFile[], at: number) {
    const b = busy('Adding pages…');
    try {
      const { pages } = await loadFiles(files);
      if (!pages.length) return;
      store.apply(ps => ps.splice(at, 0, ...pages));
      toast(`Added ${pages.length} page${pages.length > 1 ? 's' : ''}`, 'ok');
      viewer.scrollToPage(at);
    } finally { b.done(); }
  }
  async function insertDialog() {
    if (!store.pages.length) return openDialog();
    const files = await platform.openFiles('application/pdf,.pdf', true);
    if (files.length) insertFiles(files, viewer.current + 1);
  }

  async function save() {
    if (!store.pages.length) return;
    if (viewer.editing) viewer.commitText();
    const b = busy('Building PDF…');
    try {
      let note = '';
      const bytes = await exportPdf(store.pages, store.assets, { onProgress: (d, t) => b.set(`Building PDF… page ${d} of ${t}`), onNote: m => { note = m; } });
      b.done();
      const name = store.fileName.replace(/\.pdf$/i, '') + (/-edited$/i.test(store.fileName.replace(/\.pdf$/i, '')) ? '' : '-edited') + '.pdf';
      if (await platform.saveFile(name, bytes)) { dirty = false; refresh(); toast(note ? `Saved ${name}. ${note}` : `Saved ${name}`, 'ok', note ? 8000 : 3500); }
    } catch (e: any) { b.done(); console.error(e); toast(`Could not build the PDF: ${e?.message || e}`, 'error', 8000); }
  }

  // ---------- pages ----------
  function addBlank() {
    const cur = store.pages[viewer.current];
    const page = cur ? blankPage(cur.width, cur.height) : blankPage();
    const at = store.pages.length ? viewer.current + 1 : 0;
    store.apply(ps => ps.splice(at, 0, page));
    viewer.scrollToPage(at);
  }
  function rotatePage(i: number, deg: number) {
    if (!store.pages[i]) return;
    store.apply(ps => { ps[i].rotation = (ps[i].rotation + deg + 360) % 360; });
  }
  function deletePage(i: number) {
    if (!store.pages[i]) return;
    if (store.pages.length === 1) { toast('A PDF needs at least one page', 'error'); return; }
    store.apply(ps => ps.splice(i, 1));
    toast(`Deleted page ${i + 1}. Press Ctrl+Z to undo.`);
  }
  function movePage(from: number, to: number) {
    store.apply(ps => { const [p] = ps.splice(from, 1); ps.splice(to, 0, p); });
    viewer.current = to; refresh();
  }

  // ---------- images & signatures ----------
  async function fileToAsset(f: PickedFile): Promise<Asset | null> {
    const mime = sniffImage(f.bytes);
    if (!mime) { toast(`"${f.name}" is not a supported image`, 'error'); return null; }
    let dataUrl = `data:${mime};base64,${toB64(f.bytes)}`;
    const img = new Image(); img.src = dataUrl;
    try { await img.decode(); } catch { toast(`Could not read "${f.name}"`, 'error'); return null; }
    let outMime: Asset['mime'] = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    if (mime !== 'image/png' && mime !== 'image/jpeg') {
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d')!.drawImage(img, 0, 0); dataUrl = c.toDataURL('image/png'); outMime = 'image/png';
    }
    const asset: Asset = { id: uid('img'), mime: outMime, dataUrl, w: img.naturalWidth * 0.75, h: img.naturalHeight * 0.75 };
    store.assets.set(asset.id, asset);
    return asset;
  }
  async function insertImage() {
    if (!store.pages.length) { toast('Open a PDF first', 'error'); return; }
    const [f] = await platform.openFiles('image/png,image/jpeg,image/webp,image/gif', false);
    if (!f) return;
    const asset = await fileToAsset(f);
    if (asset) viewer.placeImage(asset, 300);
  }
  async function addSignature() {
    if (!store.pages.length) { toast('Open a PDF first', 'error'); return; }
    const url = await signatureDialog(async () => {
      const [f] = await platform.openFiles('image/png,image/jpeg,image/webp', false);
      if (!f) return null; const m = sniffImage(f.bytes);
      return m ? `data:${m};base64,${toB64(f.bytes)}` : null;
    });
    if (!url) return;
    const img = new Image(); img.src = url; await img.decode();
    const asset: Asset = { id: uid('sig'), mime: 'image/png', dataUrl: url, w: img.naturalWidth, h: img.naturalHeight };
    store.assets.set(asset.id, asset);
    viewer.placeImage(asset, 160);
    toast('Drag the signature into place, and drag its corner to resize', 'info', 5000);
  }

  // ---------- merge ----------
  async function mergeDialog() {
    type Item = { label: string; detail: string; pages?: PageRef[]; file?: PickedFile };
    const items: Item[] = [];
    if (store.pages.length) items.push({ label: store.fileName, detail: `current document, ${store.pages.length} pages`, pages: store.pages });
    const list = el('div', { class: 'merge-list' });
    const draw = () => {
      list.replaceChildren(...(items.length ? items.map((it, i) => el('div', { class: 'merge-item' },
        el('span', { class: 'merge-num' }, String(i + 1)),
        el('div', { class: 'merge-name' }, el('div', {}, it.label), el('div', { class: 'muted' }, it.detail)),
        el('button', { class: 'icon-btn tiny', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, html: icon('up', 14), onclick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; draw(); } }),
        el('button', { class: 'icon-btn tiny', title: 'Move down', 'aria-label': 'Move down', disabled: i === items.length - 1, html: icon('down', 14), onclick: () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; draw(); } }),
        el('button', { class: 'icon-btn tiny', title: 'Remove', 'aria-label': 'Remove', html: icon('x', 14), onclick: () => { items.splice(i, 1); draw(); } }),
      )) : [el('p', { class: 'muted' }, 'No files yet. Add two or more PDFs.')]));
    };
    const add = el('button', { class: 'btn', html: `${icon('insert', 16)}<span>Add PDFs…</span>`, onclick: async () => {
      const files = await platform.openFiles('application/pdf,.pdf', true);
      for (const f of files) items.push({ label: f.name, detail: `${(f.bytes.length / 1024 / 1024).toFixed(2)} MB`, file: f });
      draw();
    } });
    draw();
    const body = el('div', { class: 'stack' }, el('p', {}, 'Files are joined in this order. Edits on the current document are kept.'), list, add);
    const ok = await modal('Merge PDFs', body, [{ label: 'Cancel', value: false }, { label: 'Merge', value: true, primary: true }], { width: 560 });
    if (!ok) return;
    if (items.length < 2) { toast('Add at least two files to merge', 'error'); return; }
    const b = busy('Merging…');
    try {
      const merged: PageRef[] = [];
      for (const it of items) {
        if (it.pages) merged.push(...it.pages);
        else { const { pages } = await loadFiles([it.file!]); merged.push(...pages); }
      }
      if (!merged.length) return;
      if (store.pages.length) store.apply(ps => { ps.splice(0, ps.length, ...merged); });
      else { quiet = true; store.reset(merged); quiet = false; dirty = true; }
      store.fileName = 'merged.pdf';
      viewer.fitWidth(1.3); viewer.scrollToPage(0);
      toast(`Merged ${items.length} files into ${merged.length} pages. Download to save.`, 'ok', 5000);
    } finally { b.done(); }
  }

  // ---------- split ----------
  async function splitDialog() {
    const n = store.pages.length;
    if (!n) { toast('Open a PDF first', 'error'); return; }
    const modeRanges = el('input', { type: 'radio', name: 'splitmode', value: 'ranges', checked: true }) as HTMLInputElement;
    const modeEvery = el('input', { type: 'radio', name: 'splitmode', value: 'every' }) as HTMLInputElement;
    const ranges = el('input', { class: 'input', value: n > 1 ? `1-${Math.ceil(n / 2)}, ${Math.ceil(n / 2) + 1}-${n}` : '1', 'aria-label': 'Page ranges' }) as HTMLInputElement;
    const every = el('input', { class: 'input tiny-num', type: 'number', min: 1, max: n, value: 1, 'aria-label': 'Pages per file' }) as HTMLInputElement;
    const preview = el('p', { class: 'muted' });
    const groups = () => modeRanges.checked ? parseRanges(ranges.value, n) : chunkEvery(+every.value, n);
    const upd = () => {
      try { const g = groups(); preview.className = 'muted'; preview.textContent = g.length === 1 ? `Creates 1 PDF with ${g[0].length} page${g[0].length > 1 ? 's' : ''}.` : `Creates ${g.length} PDFs, downloaded together as a ZIP file.`; }
      catch (e: any) { preview.className = 'error'; preview.textContent = e.message; }
    };
    [modeRanges, modeEvery, ranges, every].forEach(x => x.addEventListener('input', upd));
    ranges.addEventListener('focus', () => { modeRanges.checked = true; upd(); });
    every.addEventListener('focus', () => { modeEvery.checked = true; upd(); });
    upd();
    const body = el('div', { class: 'stack' },
      el('p', {}, `This document has ${n} pages. Edits are included in every part.`),
      el('label', { class: 'radio' }, modeRanges, el('span', {}, 'By page ranges: each comma-separated part becomes its own file')), ranges,
      el('p', { class: 'muted small' }, 'Example: "1-3, 5, 8-10" makes 3 files. To extract pages into one file, enter one range like "2-6".'),
      el('label', { class: 'radio' }, modeEvery, el('span', {}, 'Every'), every, el('span', {}, 'pages')),
      preview);
    const ok = await modal('Split / extract pages', body, [{ label: 'Cancel', value: false }, { label: 'Split and download', value: true, primary: true }], { width: 540 });
    if (!ok) return;
    let g: number[][];
    try { g = groups(); } catch (e: any) { toast(e.message, 'error'); return; }
    const b = busy('Splitting…');
    try {
      const base = store.fileName.replace(/\.pdf$/i, '');
      const label = (idx: number[]) => idx.length === 1 ? `${idx[0] + 1}` : `${idx[0] + 1}-${idx[idx.length - 1] + 1}`;
      const parts: { name: string; bytes: Uint8Array }[] = [];
      for (let k = 0; k < g.length; k++) {
        b.set(`Building part ${k + 1} of ${g.length}…`);
        parts.push({ name: `${base}-pages-${label(g[k])}.pdf`, bytes: await exportPdf(g[k].map(i => store.pages[i]), store.assets) });
      }
      b.done();
      if (parts.length === 1) { if (await platform.saveFile(parts[0].name, parts[0].bytes)) toast(`Saved ${parts[0].name}`, 'ok'); }
      else {
        const zip = zipSync(Object.fromEntries(parts.map(p => [p.name, p.bytes])), { level: 0 });
        if (await platform.saveFile(`${base}-split.zip`, zip)) toast(`Saved ${parts.length} PDFs in ${base}-split.zip`, 'ok');
      }
    } catch (e: any) { b.done(); toast(`Split failed: ${e?.message || e}`, 'error', 8000); }
  }

  // ---------- keyboard ----------
  document.addEventListener('keydown', e => {
    if (document.querySelector('.modal-backdrop')) return;
    const t = e.target as HTMLElement;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    // Toolbar fields still let Ctrl shortcuts (undo, save…) through; real text fields keep them.
    if (inField && !(mod && t.closest('.propbar'))) return;
    if (mod && k === 'o') { e.preventDefault(); openDialog(); return; }
    if (mod && k === 's') { e.preventDefault(); save(); return; }
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); return; }
    if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); store.redo(); return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); viewer.setZoom(viewer.zoom * 1.2); return; }
    if (mod && k === '-') { e.preventDefault(); viewer.setZoom(viewer.zoom / 1.2); return; }
    if (mod && k === '0') { e.preventDefault(); viewer.fitWidth(); return; }
    if (mod) return;
    if (viewer.tool === 'edit' && viewer.edit.sel) {
      if (k === 'delete' || k === 'backspace') { e.preventDefault(); viewer.edit.deleteSelected(); return; }
      if (k === 'enter') { e.preventDefault(); viewer.edit.editSelectedText(); return; }
      if (k === 'escape') { viewer.edit.select(null); return; }
      if (k.startsWith('arrow')) {
        e.preventDefault(); const d = e.shiftKey ? 10 : 1;
        viewer.edit.nudge(k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0, k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0); return;
      }
    }
    if ((k === 'delete' || k === 'backspace') && viewer.selectedId) { e.preventDefault(); viewer.deleteSelected(); return; }
    if (k === 'escape') { viewer.setTool('select'); viewer.select(null); return; }
    if (viewer.selectedId && k.startsWith('arrow')) {
      e.preventDefault(); const d = e.shiftKey ? 10 : 1;
      viewer.nudge(k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0, k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0); return;
    }
    const tool = TOOLS.find(x => x.key.toLowerCase() === k);
    if (tool && store.pages.length) viewer.setTool(tool.id);
  });

  // ---------- drag & drop files ----------
  let dragDepth = 0;
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
  window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; dragDepth++; document.body.classList.add('dropping'); });
  window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dropping'); });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dropping');
    const files = await Promise.all(Array.from(e.dataTransfer!.files).map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    const pdfs = files.filter(f => isPdf(f.bytes)), images = files.filter(f => sniffImage(f.bytes));
    if (pdfs.length) { if (store.pages.length) insertFiles(pdfs, viewer.current + 1); else openFiles(pdfs); }
    else if (images.length && store.pages.length) { const a = await fileToAsset(images[0]); if (a) viewer.placeImage(a, 300); }
    else toast('Drop a PDF (or an image onto an open PDF)', 'error');
  });

  window.addEventListener('beforeunload', e => { if (dirty && store.pages.length) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('resize', () => { /* keep zoom; user can press Fit */ });
  platform.onExternalOpen?.(files => openFiles(files));

  // Expose for automated tests.
  (window as any).__pdfEditor = { store, viewer };
}

function isPdf(b: Uint8Array) { const head = new TextDecoder().decode(b.subarray(0, 1024)); return head.includes('%PDF-'); }
function sniffImage(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return null;
}
function toB64(b: Uint8Array) { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); }
