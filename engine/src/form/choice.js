// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Check boxes written as characters: "□ 있음   □ 없음", "해당없음□ / 저소득층□",
// a list of "□ ..." lines, or brackets: "[  ] 매도  [  ] 임대", "남(  ),여(  )".
// A choice is marked the way people mark these forms by hand in a word
// processor: an empty box is replaced by its filled form (□ → ■), one
// character for one; a bracket gets a mark written inside it (√, or the mark
// the form's instructions name), padded to the bracket's width, so nothing
// else on the line moves. Generic text heuristics; no format knowledge.

import { looksLikeLabel } from './labels.js';
import { paragraphChars } from './inline.js';
import { FORM_BOX } from './chars.js';

/** Empty boxes and what they become when checked. */
export const FILLED = { '□': '■', '☐': '☑', '▢': '▣', '◻': '◼' };
const CHECKED = new Set(Object.values(FILLED).concat(['☒']));
const BOX = new Set([...Object.keys(FILLED), ...CHECKED, FORM_BOX]);
const SPACE = /[ \u3000\u00a0]/;
const STOP = /[,，|·ㆍ]/;
/** "/" separates options only with a space beside it: "□ 예 / □ 아니오", but "수도/강원". */
const slashStop = (chars, k) => chars[k] === '/' && (SPACE.test(chars[k - 1] ?? ' ') || SPACE.test(chars[k + 1] ?? ' '));

/**
 * @typedef {object} ChoiceOption
 * @property {string} label    option text as printed
 * @property {object} paragraph
 * @property {number} pos      paragraph position of the box
 * @property {string} box      the box character
 * @property {boolean} checked already marked in the form
 *
 * @typedef {object} ChoiceLine
 * @property {ChoiceOption[]} options
 * @property {string|null} label   words before the boxes ("필수적 정보", "지원구분")
 * @property {boolean} item        a single box opening the line ("□ 주소 변동 없음"): may be one of a list
 */

/** The check boxes of a paragraph, line by line. */
export function findChoiceLines(paragraph) {
  const { chars } = paragraphChars(paragraph);
  const lines = [[]];
  for (const c of chars) {
    if (c.sep) lines.push([]);
    else lines[lines.length - 1].push(c);
  }
  return lines.map((line) => choiceLine(paragraph, line)).filter(Boolean);
}

/** Marks people write inside a bracket box; the form's own instructions may name one. */
const MARKS = /[√∨✓✔ｖvVＶ○◯OＯxXＸ]/;

/**
 * Boxes of a line: single box characters, and brackets holding only spacing
 * ("[  ]", or "( )" when a line has at least two of them) that take a mark
 * inside. Each as { i, j } (character indices, j past the box) and, for
 * brackets, the inner range to write the mark into.
 */
function boxesIn(line) {
  const text = line.map((c) => c.ch).join('');
  const out = [];
  line.forEach((c, i) => {
    if (!BOX.has(c.ch)) return;
    // "□□□-□□□" boxes take one digit each: not check boxes.
    if (BOX.has(line[i - 1]?.ch) || BOX.has(line[i + 1]?.ch)) return;
    if (c.ch === FORM_BOX) out.push({ i, j: i + 1, kind: 'form', control: c.form, checked: c.form.checked });
    else out.push({ i, j: i + 1, kind: 'char', checked: CHECKED.has(c.ch) });
  });
  const brackets = (re, kind) => [...text.matchAll(re)].map((m) => {
    const inner = m[1];
    return { i: m.index, j: m.index + m[0].length, kind, innerStart: m.index + 1, innerEnd: m.index + 1 + inner.length, checked: MARKS.test(inner) };
  });
  out.push(...brackets(/[\[［]([ \u3000]{0,6}|[ \u3000]*[√∨✓✔ｖvVＶ○◯OＯxXＸ][ \u3000]*)[\]］]/g, 'bracket'));
  const parens = brackets(/[(（]([ \u3000]{1,6}|[ \u3000]*[√∨✓✔ｖvVＶ○◯OＯ][ \u3000]*)[)）]/g, 'paren');
  if (parens.length >= 2) out.push(...parens);
  return out.sort((a, b) => a.i - b.i);
}

function choiceLine(paragraph, line) {
  const text = (i, j) => line.slice(i, j).map((c) => c.ch).join('');
  // "…없음난의 □에 ✔ 표시를 하고", "({box}에 V 표시)": a box referred to in instructions.
  const at = boxesIn(line).filter((b) => !/^(에|란|안|표|를|을|으로|로|의)/.test(text(b.j, b.j + 2)));
  if (!at.length || !at.some((b) => !b.checked)) return null;

  // Text after each box (up to the next box, a separator, a wide gap or a bracket) ...
  const after = at.map((b, n) => optionText(line, b.j, n + 1 < at.length ? at[n + 1].i : line.length, +1));
  // ... and before it.
  const before = at.map((b, n) => optionText(line, n > 0 ? at[n - 1].j : 0, b.i, -1));
  // Boxes come after their options when the last box ends its phrase and the first has words before it.
  const tail = text(at[at.length - 1].j, line.length);
  const boxAfter = before[0] !== '' && (/^[\s)）]*([\/,，|]|$)/.test(tail) || after.every((a) => a === '')) && before.every((b) => b !== '');
  // A form check box may carry its own caption.
  const labels = (boxAfter ? before : after).map((l, n) => (at[n].kind === 'form' && at[n].control.caption ? at[n].control.caption : l));
  const lead = text(0, at[0].i).trim();
  const item = at.length === 1 && !boxAfter && lead === '';
  const limit = item ? 40 : 25;
  if (labels.some((l) => !usableOption(l, limit))) {
    // A box in front of a sentence or heading is a bullet, not a check box.
    return null;
  }
  // Words before the first box name the group ("필수적 정보 (동의함 ☐ ...").
  let label = boxAfter ? text(0, at[0].i).replace(labels[0], '') : lead;
  // Only the phrase right before the boxes: after the last wide gap.
  label = label.split(/[ \u3000]{2,}/).pop().replace(/[(（\s:：]+$/, '').replace(/^[\s(（]+/, '').trim();
  if (/^[가-힣]$/.test(label)) label = '';
  return {
    options: at.map((b, n) => ({
      label: labels[n],
      paragraph,
      pos: line[b.i].pos,
      box: b.kind === 'char' ? line[b.i].ch : null,
      kind: b.kind,
      control: b.control,
      // The spacing inside a bracket box, where the mark is written.
      start: b.kind === 'char' || b.kind === 'form' ? undefined : line[b.innerStart]?.pos ?? line[b.i].pos + 1,
      end: b.kind === 'char' || b.kind === 'form' ? undefined : b.innerEnd > b.innerStart ? line[b.innerEnd - 1].pos + 1 : line[b.i].pos + 1,
      checked: b.checked,
    })),
    label: label && looksLikeLabel(label) ? label : null,
    item,
  };
}

function optionText(line, i, j, dir) {
  const chars = line.slice(i, j).map((c) => c.ch);
  if (dir > 0) {
    let s = '';
    let gap = 0;
    for (let k = 0; k < chars.length; k++) {
      const ch = chars[k];
      if (SPACE.test(ch)) { if (s && ++gap >= 2) break; s += ch; continue; }
      gap = 0;
      if (STOP.test(ch) || slashStop(chars, k) || ch === ')' || ch === '）') break;
      if (ch === '(' || ch === '（') {
        // "보훈대상(10%)" keeps its bracket; "기타(      )" holds a blank of its own.
        const close = chars.findIndex((c, m) => m > k && (c === ')' || c === '）'));
        const inside = close > k ? chars.slice(k + 1, close).join('') : '';
        if (close < 0 || !inside.trim() || /^[_\s]+$/.test(inside)) break;
        s += chars.slice(k, close + 1).join('');
        k = close;
        continue;
      }
      s += ch;
    }
    return s.trim();
  }
  let s = '';
  let gap = 0;
  for (let k = chars.length - 1; k >= 0; k--) {
    const ch = chars[k];
    if (SPACE.test(ch)) { if (s && ++gap >= 2) break; s = ch + s; continue; }
    gap = 0;
    if (STOP.test(ch) || slashStop(chars, k) || ch === '(' || ch === '（') break;
    s = ch + s;
  }
  return s.trim();
}

function usableOption(label, limit) {
  const t = label.replace(/\s+/g, '');
  if (!t || t.length > limit) return false;
  if (/[.。]$/.test(t) && t.length > 10) return false; // a sentence
  if (/[:：]/.test(t) && t.length > 12) return false; // "경력 사항 : 지원한 ..." (a heading)
  return /[가-힣A-Za-z0-9%]/.test(t);
}

// ---- values --------------------------------------------------------------------

const YES = /^(y|yes|true|1|o|v|✓|✔|예|네|해당|있음|체크|선택|동의|동의함)$/i;
const NO = /^(n|no|false|0|x|아니오|아니요|없음|해당없음|미동의|-)?$/i;
const norm = (s) => s.normalize('NFC').replace(/\s+/g, '').replace(/[()（）]/g, '').toLowerCase();

/** Options of a group chosen by `value` ("있음", "우편, 팩스", or yes/no for a single box). */
export function chooseOptions(options, value) {
  const v = String(value).trim();
  const exact = options.filter((o) => norm(o.label) === norm(v));
  if (exact.length === 1) return exact;
  if (options.length === 1) {
    if (YES.test(v) || norm(v) === norm(options[0].label)) return options;
    if (NO.test(v)) return [];
    throw new RangeError(`"${v}" is not a yes/no answer for "${options[0].label}"`);
  }
  const wanted = v.split(/\s*[,;|]\s*|\s+\/\s*|\s*\/\s+/).filter(Boolean);
  const out = [];
  for (const w of wanted) {
    const n = norm(w);
    let hit = options.filter((o) => norm(o.label) === n);
    if (!hit.length) hit = options.filter((o) => norm(o.label).startsWith(n) || n.startsWith(norm(o.label)));
    if (hit.length !== 1) {
      throw new RangeError(`"${w}" ${hit.length ? 'matches several' : 'matches none'} of ${options.map((o) => o.label).join(', ')}`);
    }
    out.push(hit[0]);
  }
  return out;
}

/**
 * The mark a document asks for in its instructions ("√표를 합니다",
 * "ｖ표를 하시기 바랍니다", "○표"), or √.
 */
export function markFor(texts) {
  for (const t of texts) {
    const m = /([√∨✓✔ｖvVＶ○◯])\s*표/.exec(t);
    if (m) return m[1];
  }
  return '√';
}
