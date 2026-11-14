// Signature dialog: draw, type or upload. Saved signatures stay in this browser (localStorage).
import { el, modal, toast } from './dialogs';
import { icon } from './icons';

const KEY = 'pdf-editor.signatures';
const load = (): string[] => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const store = (list: string[]) => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 8))); } catch { /* storage unavailable */ } };

/** Crop transparent edges; returns a PNG data URL or null if empty. */
function trim(c: HTMLCanvasElement): string | null {
  const ctx = c.getContext('2d')!, { width: w, height: h } = c;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const pad = 4, out = document.createElement('canvas');
  out.width = x1 - x0 + 1 + pad * 2; out.height = y1 - y0 + 1 + pad * 2;
  out.getContext('2d')!.drawImage(c, x0 - pad, y0 - pad, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

export async function signatureDialog(pickImage: () => Promise<string | null>): Promise<string | null> {
  let mode: 'draw' | 'type' | 'upload' = 'draw';
  let uploaded: string | null = null;
  let color = '#0b2a6f';

  // Draw pad
  const pad = el('canvas', { class: 'sig-pad', width: 1000, height: 340 }) as HTMLCanvasElement;
  const pctx = pad.getContext('2d')!;
  pctx.lineCap = 'round'; pctx.lineJoin = 'round';
  let drawing = false, last: [number, number] | null = null;
  const pos = (e: PointerEvent): [number, number] => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height]; };
  pad.addEventListener('pointerdown', e => { drawing = true; last = pos(e); pad.setPointerCapture(e.pointerId); pctx.beginPath(); pctx.fillStyle = color; pctx.arc(last[0], last[1], 2.5, 0, Math.PI * 2); pctx.fill(); });
  pad.addEventListener('pointermove', e => {
    if (!drawing || !last) return;
    const p = pos(e); pctx.strokeStyle = color; pctx.lineWidth = 5;
    pctx.beginPath(); pctx.moveTo(...last); pctx.lineTo(...p); pctx.stroke(); last = p;
  });
  pad.addEventListener('pointerup', () => { drawing = false; last = null; });

  // Type
  const typed = el('input', { class: 'input', placeholder: 'Type your name', maxlength: 60 }) as HTMLInputElement;
  const fontSel = el('select', { class: 'input' },
    ...['"Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive', 'Georgia, serif', '"Times New Roman", serif'].map((f, i) => el('option', { value: f }, ['Handwriting', 'Georgia', 'Times'][i]))) as HTMLSelectElement;
  const typedPreview = el('div', { class: 'sig-typed' });
  const updTyped = () => { typedPreview.textContent = typed.value || 'Your name'; typedPreview.style.fontFamily = fontSel.value; typedPreview.style.color = color; };
  typed.oninput = updTyped; fontSel.onchange = updTyped; updTyped();

  // Upload
  const upImg = el('img', { class: 'sig-upload-img', alt: '' }) as HTMLImageElement;
  const upBtn = el('button', { class: 'btn', onclick: async () => { uploaded = await pickImage(); if (uploaded) { upImg.src = uploaded; upImg.style.display = 'block'; } } }, 'Choose image…');
  const upHint = el('p', { class: 'muted' }, 'A photo or scan of your signature. Near-white background becomes transparent.');

  const panes = {
    draw: el('div', { class: 'stack' }, pad, el('div', { class: 'row' }, el('span', { class: 'muted' }, 'Sign with mouse, pen or finger'), el('button', { class: 'btn small', onclick: () => pctx.clearRect(0, 0, pad.width, pad.height) }, 'Clear'))),
    type: el('div', { class: 'stack' }, typed, fontSel, typedPreview),
    upload: el('div', { class: 'stack' }, upBtn, upHint, upImg),
  };
  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  const showTab = (m: typeof mode) => {
    mode = m;
    for (const [k, p] of Object.entries(panes)) (p as HTMLElement).style.display = k === m ? '' : 'none';
    tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.m === m)));
  };
  for (const [m, label] of [['draw', 'Draw'], ['type', 'Type'], ['upload', 'Upload']] as const)
    tabs.append(el('button', { class: 'tab', role: 'tab', 'data-m': m, onclick: () => showTab(m) }, label));

  const colors = el('div', { class: 'row' }, el('span', { class: 'muted' }, 'Ink'),
    ...['#0b2a6f', '#111111', '#1d4ed8'].map(c => el('button', { class: 'swatch', style: `background:${c}`, title: c, 'aria-label': `Ink ${c}`, onclick: () => { color = c; updTyped(); } })));

  // Saved signatures
  let saved = load();
  const savedBox = el('div', { class: 'sig-saved' });
  let chosenSaved: string | null = null;
  let closeFn: ((v: any) => void) | null = null;
  const drawSaved = () => {
    savedBox.replaceChildren();
    if (!saved.length) return;
    savedBox.append(el('div', { class: 'muted' }, 'Saved signatures: click one to use it'));
    const row = el('div', { class: 'sig-saved-row' });
    saved.forEach((url, i) => row.append(el('div', { class: 'sig-saved-item' },
      el('button', { class: 'sig-saved-use', title: 'Use this signature', onclick: () => { chosenSaved = url; closeFn?.('saved'); } }, el('img', { src: url, alt: 'Saved signature' })),
      el('button', { class: 'icon-btn tiny', title: 'Delete', 'aria-label': 'Delete saved signature', html: icon('x', 14), onclick: () => { saved.splice(i, 1); store(saved); drawSaved(); } }))));
    savedBox.append(row);
  };
  drawSaved();

  const body = el('div', { class: 'stack' }, savedBox, tabs, panes.draw, panes.type, panes.upload, colors);
  showTab('draw');
  const res = await modal('Add signature', body, [{ label: 'Cancel', value: null }, { label: 'Place signature', value: 'new', primary: true }], { width: 620, onOpen: c => { closeFn = c; } });
  if (res === 'saved') return chosenSaved;
  if (res !== 'new') return null;

  let url: string | null = null;
  if (mode === 'draw') url = trim(pad);
  else if (mode === 'type') {
    if (!typed.value.trim()) { toast('Type your name first', 'error'); return null; }
    const c = document.createElement('canvas'); c.width = 1400; c.height = 300;
    const ctx = c.getContext('2d')!; ctx.font = `120px ${fontSel.value}`; ctx.fillStyle = color; ctx.textBaseline = 'middle';
    ctx.fillText(typed.value.trim(), 20, 150); url = trim(c);
  } else if (uploaded) url = await knockOutWhite(uploaded);
  if (!url) { toast('The signature is empty', 'error'); return null; }
  saved = [url, ...saved.filter(u => u !== url)]; store(saved);
  return url;
}

async function knockOutWhite(dataUrl: string): Promise<string | null> {
  const img = new Image(); img.src = dataUrl; await img.decode();
  const scale = Math.min(1, 1200 / img.naturalWidth);
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0, c.width, c.height);
  const id = ctx.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; if (l > 215) d[i + 3] = 0; else if (l > 170) d[i + 3] = Math.round(d[i + 3] * (215 - l) / 45); }
  ctx.putImageData(id, 0, 0);
  return trim(c);
}
