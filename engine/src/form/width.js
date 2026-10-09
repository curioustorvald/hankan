// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// How wide text will print, approximately, so that a value written into a
// blank of spaces can be padded to the blank's width and leave the rest of
// the line where it was.
//
// A character's advance is its glyph width (in em, by character class and
// font) scaled by the character shape's width ratio, relative size and
// letter spacing, all per language (hwp5 표 33; owpml-ksx6101 §9.3.4.2).
// Letter spacing (자간) scales the advance like the ratio does: renders show
// it is a share of the character's own width, not a fixed amount (R6). Glyph widths are not in any source:
// DEFAULT holds round figures, and MEASURED (from render batches, see
// tools/render/calibrate.py) replaces them: BASE for every font, MEASURED
// where a font differs.

import { BASE, MEASURED } from './metrics.js';

/** Character class and the language whose font and scaling apply to it. */
export function charClass(ch) {
  if (ch === ' ' || ch === '\u00a0') return 'space';
  if (ch === '\u3000') return 'wideSpace';
  if (/[가-힣ᄀ-ᇿ㄰-㆏]/.test(ch)) return 'hangul';
  if (/[0-9]/.test(ch)) return 'digit';
  if (/[A-Z]/.test(ch)) return 'upper';
  if (/[a-z]/.test(ch)) return 'lower';
  if (/[一-鿿豈-﫿]/.test(ch)) return 'hanja';
  if (/[!-~]/.test(ch)) return 'punct';
  return 'wide';
}

const LANG = { space: 'latin', wideSpace: 'hangul', hangul: 'hangul', digit: 'latin', upper: 'latin', lower: 'latin', punct: 'latin', hanja: 'hanja', wide: 'symbol' };

/** Glyph widths in em when nothing better is known. */
export const DEFAULT = { space: 0.5, wideSpace: 1, hangul: 1, digit: 0.5, upper: 0.65, lower: 0.5, punct: 0.4, hanja: 1, wide: 1 };
function glyph(cls, style) {
  const face = style?.face?.[LANG[cls]] ?? null;
  const key = cls === 'space' && style?.fontSpace ? 'fontSpace' : cls;
  return (face ? MEASURED[face]?.[key] : undefined) ?? BASE[key] ?? DEFAULT[cls];
}

/** Advance of one character in em of the style's base size. */
export function advance(ch, style) {
  const cls = charClass(ch);
  const lang = LANG[cls];
  const ratio = (style?.ratio?.[lang] ?? 100) / 100;
  const rel = (style?.relSize?.[lang] ?? 100) / 100;
  const spacing = (style?.spacing?.[lang] ?? 0) / 100;
  return glyph(cls, style) * ratio * rel * (1 + spacing);
}

/** Base size of a style in HWPUNIT (1000 = 10 pt when unknown). */
export function sizeOf(style) {
  return style?.size || 1000;
}

/** Width of text in HWPUNIT, in one style. */
export function absWidth(text, style) {
  return textWidth(text, style) * sizeOf(style);
}

export function textWidth(text, style) {
  let w = 0;
  for (const ch of text) w += advance(ch, style);
  return w;
}
