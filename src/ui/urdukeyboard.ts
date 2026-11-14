// On-screen Urdu keyboard. Shown while a text box is being typed in an Urdu font.
// Keys are laid out right-to-left. Buttons never take focus (mousedown is cancelled), so the text
// box keeps its caret and is not closed by a click on the keyboard.
import { el } from './dialogs';

type Layer = string[][];
const NORMAL: Layer = [
  ['۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹', '۰'],
  ['ق', 'و', 'ع', 'ر', 'ت', 'ے', 'ء', 'ی', 'ہ', 'پ'],
  ['ا', 'س', 'د', 'ف', 'گ', 'ھ', 'ج', 'ک', 'ل', 'ں'],
  ['ز', 'ش', 'چ', 'ط', 'ب', 'ن', 'م', '،', '۔', '؟'],
];
const SHIFT: Layer = [
  ['!', '(', ')', '«', '»', ':', '؛', '٪', '٭', '-'],
  ['ٹ', 'ث', 'ح', 'خ', 'ڈ', 'ذ', 'ڑ', 'ژ', 'ص', 'ض'],
  ['ظ', 'غ', 'آ', 'ئ', 'ؤ', 'ۃ', 'ۓ', '.', '"', '\''],
  ['َ', 'ُ', 'ِ', 'ّ', 'ْ', 'ٰ', 'ً', 'ٔ', '٫', '٬'],
];
const MARKS = /[\u064B-\u065F\u0670]/;

let panel: HTMLElement | null = null;
let target: HTMLTextAreaElement | null = null;
let shifted = false;
let dismissed: HTMLTextAreaElement | null = null; // text box whose keyboard the user closed

function insert(text: string) {
  const ta = target; if (!ta) return;
  const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
  ta.setRangeText(text, a, b, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
}
function backspace() {
  const ta = target; if (!ta) return;
  let a = ta.selectionStart ?? 0; const b = ta.selectionEnd ?? a;
  if (a === b) { if (a === 0) return; a -= 1; }
  ta.setRangeText('', a, b, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
}

function keyButton(label: string, onPress: () => void, cls = '') {
  const b = el('button', { type: 'button', class: `ukey ${cls}`, tabindex: '-1' }, label);
  if (MARKS.test(label)) { b.textContent = '◌' + label; b.title = 'Vowel mark'; }
  b.addEventListener('mousedown', e => e.preventDefault()); // keep the text box focused
  b.addEventListener('pointerdown', e => e.preventDefault());
  b.addEventListener('click', e => { e.preventDefault(); onPress(); });
  return b;
}

function render() {
  if (!panel) return;
  const layer = shifted ? SHIFT : NORMAL;
  const rows = layer.map(r => el('div', { class: 'urow' }, ...r.map(k => keyButton(k, () => insert(k)))));
  const bottom = el('div', { class: 'urow' },
    keyButton(shifted ? 'حروف' : 'اعراب / ٹ ث', () => { shifted = !shifted; render(); }, 'wide'),
    keyButton('خالی جگہ', () => insert(' '), 'space'),
    keyButton('نئی سطر', () => insert('\n'), 'wide'),
    keyButton('⌫', backspace, 'wide'));
  const head = el('div', { class: 'uhead' },
    el('span', {}, 'اردو کی بورڈ · Urdu keyboard'),
    (() => {
      const x = keyButton('×', () => { dismissed = target; hideUrduKeyboard(); }, 'close');
      x.title = 'Hide keyboard'; x.setAttribute('aria-label', 'Hide keyboard'); return x;
    })());
  panel.replaceChildren(head, ...rows, bottom);
}

/** Show the keyboard for `ta` (or hide it when `visible` is false). Safe to call on every keystroke. */
export function updateUrduKeyboard(ta: HTMLTextAreaElement, visible: boolean) {
  if (!visible || dismissed === ta) { if (!visible) hideUrduKeyboard(); return; }
  if (!panel) {
    panel = el('div', { class: 'urdu-kb', dir: 'rtl', role: 'group', 'aria-label': 'Urdu keyboard' });
    panel.addEventListener('mousedown', e => e.preventDefault());
    document.body.append(panel);
    render();
  }
  target = ta;
}

export function hideUrduKeyboard() {
  panel?.remove(); panel = null; target = null; shifted = false;
}

/** Call when a text box closes: forget which box's keyboard was dismissed, and hide the panel. */
export function endUrduKeyboard() { dismissed = null; hideUrduKeyboard(); }
