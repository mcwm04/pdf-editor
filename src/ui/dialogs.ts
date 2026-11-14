// In-page dialogs (alert/prompt/confirm are blocked in sandboxed frames).
import { icon } from './icons';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) (e as any)[k.toLowerCase()] = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids) e.append(kid);
  return e;
}

export interface Button { label: string; value: any; primary?: boolean; danger?: boolean }

/** Show a modal. Resolves with the clicked button's value, or null when closed. */
export function modal(title: string, body: Node, buttons: Button[], opts: { width?: number; onOpen?: (close: (v: any) => void) => void } = {}): Promise<any> {
  return new Promise(resolve => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const backdrop = el('div', { class: 'modal-backdrop' });
    const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    if (opts.width) box.style.width = `min(${opts.width}px, 94vw)`;
    const close = (v: any) => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); prevFocus?.focus?.(); resolve(v); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        const primary = buttons.find(b => b.primary);
        if (primary) { e.preventDefault(); e.stopPropagation(); close(primary.value); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    const head = el('div', { class: 'modal-head' }, el('h2', {}, title),
      el('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close', html: icon('x'), onclick: () => close(null) }));
    const foot = el('div', { class: 'modal-foot' });
    for (const b of buttons) foot.append(el('button', { class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`, onclick: () => close(b.value) }, b.label));
    box.append(head, el('div', { class: 'modal-body' }, body), foot);
    backdrop.append(box);
    backdrop.addEventListener('pointerdown', e => { if (e.target === backdrop) close(null); });
    document.body.append(backdrop);
    opts.onOpen?.(close);
    (box.querySelector('input, select, textarea') as HTMLElement || box.querySelector('.btn.primary') as HTMLElement)?.focus();
  });
}

export async function askPassword(fileName: string, wrong: boolean): Promise<string | null> {
  const input = el('input', { type: 'password', class: 'input', placeholder: 'Password', autocomplete: 'off' }) as HTMLInputElement;
  const body = el('div', { class: 'stack' },
    el('p', {}, `"${fileName}" is password-protected.`),
    ...(wrong ? [el('p', { class: 'error' }, 'That password was wrong. Try again.')] : []),
    input);
  const ok = await modal('Password needed', body, [{ label: 'Cancel', value: false }, { label: 'Open', value: true, primary: true }]);
  return ok ? input.value : null;
}

export function confirmBox(title: string, text: string, okLabel = 'OK', danger = false): Promise<boolean> {
  return modal(title, el('p', {}, text), [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: !danger, danger }]).then(v => !!v);
}

let toastTimer: number | undefined;
export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 3500) {
  let t = document.getElementById('toast');
  if (!t) { t = el('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
  t.textContent = msg; t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t!.className = ''; }, ms);
}

/** Full-screen busy overlay; returns a function to update the text and one to hide it. */
export function busy(text: string) {
  const o = el('div', { class: 'busy' }, el('div', { class: 'spinner' }), el('div', { class: 'busy-text' }, text));
  document.body.append(o);
  return { set: (t: string) => { (o.querySelector('.busy-text') as HTMLElement).textContent = t; }, done: () => o.remove() };
}
