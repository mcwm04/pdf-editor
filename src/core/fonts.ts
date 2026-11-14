// Font registry shared by the screen and the PDF writer: which fonts exist, their line metrics,
// and the bundled Urdu fonts (Noto Nastaliq Urdu, Noto Naskh Arabic; SIL Open Font License).
import nastaliqRegular from '../assets/fonts/NotoNastaliqUrdu-Regular.ttf?base64';
import nastaliqBold from '../assets/fonts/NotoNastaliqUrdu-Bold.ttf?base64';
import naskhRegular from '../assets/fonts/NotoNaskhArabic-Regular.ttf?base64';
import naskhBold from '../assets/fonts/NotoNaskhArabic-Bold.ttf?base64';
import type { FontName } from './model';

export const URDU_FONTS = ['Nastaliq', 'Naskh'] as const;
export type UrduFont = typeof URDU_FONTS[number];
export const isUrduFont = (f: FontName): f is UrduFont => f === 'Nastaliq' || f === 'Naskh';

export const FONT_LABEL: Record<FontName, string> = {
  Helvetica: 'Helvetica', Times: 'Times', Courier: 'Courier', Nastaliq: 'اردو نستعلیق (Urdu Nastaliq)', Naskh: 'اردو نسخ (Urdu Naskh)',
};

/** CSS family per font. Urdu families fall back to Helvetica/Arial for Latin letters, as export does. */
export const FONT_CSS: Record<FontName, string> = {
  Helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  Times: '"Times New Roman", Times, "Liberation Serif", serif',
  Courier: '"Courier New", Courier, "Liberation Mono", monospace',
  Nastaliq: '"PE Noto Nastaliq Urdu", Helvetica, Arial, sans-serif',
  Naskh: '"PE Noto Naskh Arabic", Helvetica, Arial, sans-serif',
};

/**
 * Line metrics in em. `lh` = line height, `base` = baseline below the line top (used on screen and in the PDF),
 * `editor` = where a CSS textarea puts the baseline with the same line height (so typing does not jump).
 * Urdu values come from the fonts' hhea ascent/descent: base = (lh - (asc + desc)) / 2 + asc.
 */
export const METRICS: Record<FontName, { lh: number; base: number; editor: number }> = {
  Helvetica: { lh: 1.2, base: 0.8, editor: 0.9465 },
  Times: { lh: 1.2, base: 0.8, editor: 0.9375 },
  Courier: { lh: 1.2, base: 0.8, editor: 0.8665 },
  Nastaliq: { lh: 2.2, base: 1.754, editor: 1.754 },   // asc 1.904, desc 0.596
  Naskh: { lh: 1.8, base: 1.1175, editor: 1.1175 },    // asc 1.069, desc 0.634
};

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
export const hasArabicScript = (s: string) => ARABIC_SCRIPT.test(s);

/** The font actually used: Urdu text typed into a Latin-font box is shown and saved in Nastaliq. */
export const effectiveFont = (font: FontName, text: string): FontName =>
  !isUrduFont(font) && hasArabicScript(text) ? 'Nastaliq' : font;

/** Paragraph direction, like dir="auto": from the first strong character. */
export function isRtlText(s: string) {
  const m = s.match(/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]|[֐-ࣿיִ-﷿ﹰ-﻿]/);
  return !!m && /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(m[0]);
}

const decode = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const cache = new Map<string, Uint8Array>();
export function urduFontBytes(font: UrduFont, bold: boolean): Uint8Array {
  const key = `${font}-${bold}`;
  if (!cache.has(key)) cache.set(key, decode(font === 'Nastaliq' ? (bold ? nastaliqBold : nastaliqRegular) : (bold ? naskhBold : naskhRegular)));
  return cache.get(key)!;
}
export const URDU_PS_NAME: Record<string, string> = {
  'Nastaliq-false': 'NotoNastaliqUrdu-Regular', 'Nastaliq-true': 'NotoNastaliqUrdu-Bold',
  'Naskh-false': 'NotoNaskhArabic-Regular', 'Naskh-true': 'NotoNaskhArabic-Bold',
};
export const URDU_BBOX: Record<string, number[]> = {
  'Nastaliq-false': [-379, -1382, 4531, 1808], 'Nastaliq-true': [-379, -1518, 5037, 1981],
  'Naskh-false': [-247, -590, 12176, 1405], 'Naskh-true': [-241, -553, 12192, 1408],
};

/** Register the Urdu fonts with the page so the screen uses exactly the files the PDF embeds. */
export async function loadScreenFonts() {
  const faces: [string, UrduFont, boolean][] = [
    ['PE Noto Nastaliq Urdu', 'Nastaliq', false], ['PE Noto Nastaliq Urdu', 'Nastaliq', true],
    ['PE Noto Naskh Arabic', 'Naskh', false], ['PE Noto Naskh Arabic', 'Naskh', true],
  ];
  await Promise.all(faces.map(async ([family, font, bold]) => {
    try {
      const face = new FontFace(family, urduFontBytes(font, bold).slice().buffer, { weight: bold ? '700' : '400' });
      document.fonts.add(await face.load());
    } catch (e) { console.warn('Could not load font', family, e); }
  }));
}
