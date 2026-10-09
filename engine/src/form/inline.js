// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Blanks inside running text: the spaces (or underscores) left for writing
// in, as in "성명:          (서명)", "20   년    월    일" or
// "(주민등록번호        -         )". Generic text heuristics over the
// characters of a paragraph; no format knowledge.
//
// A paragraph is split into lines at tabs, controls, line breaks and
// click-here fields. In each line, runs of spacing are blanks only in
// recognised places; the rest is layout (indentation, letter spacing such as
// "위     임     장", gaps between choices). Each blank records the exact
// positions of its spaces, so that filling replaces them and nothing else.

import { looksLikeLabel } from './labels.js';
import { fieldSpans } from './slots.js';
import { advance, absWidth, sizeOf } from './width.js';
import { FORM_BOX } from './chars.js';

export { FORM_BOX };

const SPACE = /[ \u3000\u00a0]/;
const SINGLE_SYLLABLE = /^[가-힣]$/;
const DATE_UNITS = new Set(['년', '월', '일', '시', '분']);
/** Words a number or name is written in front of. */
const UNIT_WORDS = new Set(['원', '명', '세', '부', '통', '건', '매', '회', '개', '장', '층', '번지', '호', '호실', '동', '리',
  '시간', '개월', '일간', '주간', '년간', '은행', '지점', '%', '㎡', '㎞', '평', '살', '권', '쪽']);
/** "제 [ ] 호" and the like. */
const ORDINAL_UNITS = new Set(['호', '조', '항', '회', '차', '기', '절', '권']);
/** Signature marks a name is written in front of. */
const SIGN_MARK = /^[(（]\s*(?:서명|인|날인|印|인감|서명\s*(?:또는|및|혹은)\s*(?:날인|인|도장)|인감\s*날인|서명\s*날인|자필\s*서명)\s*[)）]$/;
/** Numbers written in parts separated by "-". */
const SPLIT_LABEL = /(주민등록번호|외국인등록번호|법인등록번호|사업자등록번호|여권번호|전화번호|휴대전화번호|휴대전화|휴대폰|팩스번호|우편번호|계좌번호)\s*[:：]?\s*$/;
const BULLET = /^[□■○●◦※*\-·•▪]/;
/** Bracketed words that mark a place rather than ask for a value. */
const MARK_WORD = /^(계인|직인|간인|인감|사진|반명함판|명함판|도장|서명|날인|인|앞쪽|뒤쪽|앞면|뒷면|뒷쪽|쪽|별지|붙임|첨부)$/;
/** List numbering: "2. ", "가. ", "(3)", "1)". */
const NUMBERED = /^(?:\d+|[가-하])[.)](?:\s|$)|^[(（]\d+[)）]/;

/**
 * @typedef {object} BlankPart
 * @property {number} start   paragraph position of the first character of the blank
 * @property {number} end     paragraph position after its last character
 * @property {'value'|'year'|'month'|'day'|'part'} role
 * @property {'left'|'right'} align  where the value goes in the blank
 * @property {string} [prefix] digits printed before a year ("20")
 *
 * @typedef {object} InlineBlank
 * @property {'text'|'date'|'split'|'append'} kind
 * @property {string[]} display label as printed (one entry, or none)
 * @property {BlankPart[]} parts
 * @property {string|null} lead label opening the paragraph, as context
 */

/** Characters of a paragraph with their positions; controls, tabs and fields become separators. */
export function paragraphChars(paragraph) {
  const fields = fieldSpans(paragraph).filter((s) => s.field.kind === 'clickhere');
  const inField = (u) => fields.some((s) => u.pos >= s.begin.pos && u.end <= s.end.end);
  const units = paragraph.units();
  const out = [];
  for (const u of units) {
    if (u.type === 'end') break;
    // A form check box or radio button stands in the text like a box character.
    if (u.type === 'control' && u.control?.formType) { out.push({ ch: FORM_BOX, pos: u.pos, form: u.control, sep: false }); continue; }
    if (u.type === 'control' || inField(u)) { out.push({ ch: '\uFFFC', pos: u.pos, sep: true }); continue; }
    for (let i = 0; i < u.text.length; i++) out.push({ ch: u.text[i], pos: u.pos + i, sep: u.text[i] === '\n' });
  }
  return { chars: out, end: units[units.length - 1].pos };
}

/** All inline blanks of a paragraph. */
export function findInlineBlanks(paragraph) {
  const { chars, end } = paragraphChars(paragraph);
  const lines = [[]];
  for (const c of chars) {
    if (c.sep) lines.push([]);
    else lines[lines.length - 1].push(c);
  }
  const lastChar = chars[chars.length - 1];
  const found = [];
  lines.forEach((line, n) => {
    if (!line.length) return;
    const atEnd = n === lines.length - 1 && line[line.length - 1] === lastChar;
    found.push(...blanksInLine(line, atEnd ? end : null));
  });
  // A label opening the paragraph is context for its blanks, unless the gap
  // after it is itself a blank (then it is that blank's own label).
  const lead = leadLabel(lines[0]);
  const gap = lead ? tokenize(lines[0])[1] : null;
  const gapIsBlank = gap && found.some((b) => b.parts.some((p) => p.start <= lines[0][gap.i].pos && lines[0][gap.j - 1].pos < p.end));
  return found.map((b) => ({ ...b, lead: lead && !gapIsBlank ? lead : null }));
}

// ---- tokens ------------------------------------------------------------------

/** Words and runs of spacing, with their extent [i, j) in the line. */
function tokenize(line) {
  const toks = [];
  let i = 0;
  while (i < line.length) {
    const kind = SPACE.test(line[i].ch) ? 'space' : line[i].ch === '_' ? 'under' : 'word';
    let j = i + 1;
    while (j < line.length && (kind === 'space' ? SPACE.test(line[j].ch) : kind === 'under' ? line[j].ch === '_' : !SPACE.test(line[j].ch) && line[j].ch !== '_')) j++;
    const text = line.slice(i, j).map((c) => c.ch).join('');
    if (kind === 'space' || (kind === 'under' && j - i >= 3)) {
      toks.push({ run: true, under: kind === 'under', text, i, j, weight: [...text].reduce((w, c) => w + (c === '\u3000' ? 2 : 1), 0) });
    } else if (toks.length && !toks[toks.length - 1].run) {
      Object.assign(toks[toks.length - 1], { text: toks[toks.length - 1].text + text, j }); // "a__b" stays one word
    } else {
      toks.push({ run: false, text, i, j });
    }
    i = j;
  }
  return mergeLetterSpacing(toks);
}

/**
 * "주      소:" or "위     임     장": single syllables evenly spaced are one
 * word. Not merged: date units ("년    월    일") and "제    호".
 */
function mergeLetterSpacing(toks) {
  const syllable = (x) => x && !x.run && SINGLE_SYLLABLE.test(x.text.replace(/[:：]$/, ''));
  const out = [];
  let k = 0;
  while (k < toks.length) {
    const t = toks[k];
    if (syllable(t) && toks[k + 1]?.run && !toks[k + 1].under && syllable(toks[k + 2]) && !/[:：]$/.test(t.text)) {
      const parts = [t];
      const gaps = [];
      let m = k;
      while (toks[m + 1]?.run && !toks[m + 1].under && syllable(toks[m + 2]) && !/[:：]$/.test(toks[m].text)) {
        gaps.push(toks[m + 1].weight);
        parts.push(toks[m + 2]);
        m += 2;
      }
      const syll = parts.map((p) => p.text.replace(/[:：]$/, ''));
      const date = syll.filter((s) => DATE_UNITS.has(s)).length >= 2;
      const ordinal = syll.length === 2 && syll[0] === '제' && ORDINAL_UNITS.has(syll[1]);
      if (!date && !ordinal && Math.max(...gaps) - Math.min(...gaps) <= 1) {
        out.push({ run: false, spaced: true, text: parts.map((p) => p.text).join(''), i: t.i, j: parts[parts.length - 1].j });
        k = m + 1;
        continue;
      }
    }
    out.push(t);
    k++;
  }
  return out;
}

/** Text of the words from token k on, joined over single spaces, up to and including a closing bracket. */
function bracketFrom(toks, k) {
  let s = '';
  for (let m = k; m < toks.length; m++) {
    const t = toks[m];
    if (t.run) { if (t.weight >= 2 || t.under) break; s += ' '; continue; }
    s += t.text;
    if (/[)）]/.test(t.text)) break;
  }
  return s;
}

/** The label ending at token k: words back to a wide gap, an opening bracket or the line start. */
function labelPhrase(toks, k) {
  const words = [];
  for (let m = k; m >= 0; m--) {
    const t = toks[m];
    if (t.run) { if (t.weight >= 2 || t.under) break; continue; }
    words.unshift(t.text);
    if (/^[(（]/.test(t.text)) break;
  }
  let p = words.join(' ').trim().replace(/[:：]$/, '').trim();
  const whole = /^[(（]([^()（）]+)[)）]$/.exec(p);
  p = whole ? whole[1] : p.replace(/^[(（]/, '').replace(/[(（][^()（）]*[)）]$/, '');
  p = p.replace(/^위\s+/, '').replace(/^[,，.·\s]+/, '').trim();
  return usableLabel(p) ? p : null;
}

/** A label worth naming a blank by: words, not marks, numbering, bullets, amounts or placeholders. */
function usableLabel(p) {
  if (!p || !/[가-힣A-Za-z]/.test(p) || /^\d/.test(p)) return false; // "500원"
  if (!/[가-힣A-WYZa-wyz]/.test(p.replace(/[○●◯]/g, '')) || /(.)\1\1/.test(p.replace(/\s/g, ''))) return false; // "XXXXX", "가가가가-X-XX"
  return !SIGN_MARK.test(`(${p})`) && !MARK_WORD.test(p) && !BULLET.test(p) && !NUMBERED.test(p) && looksLikeLabel(p);
}

/** The label opening a paragraph ("신청인      (성명) ..."), kept as context. */
export function leadLabel(line) {
  if (!line?.length) return null;
  const toks = tokenize(line);
  const [first, gap] = toks;
  if (!first || first.run || !gap?.run || gap.weight < 2) return null;
  if (/[:：]$/.test(first.text)) return null; // labels its own blank
  const text = first.text.replace(/[(（][^()（）]*[)）]$/, '');
  if (!text || /^[(（]/.test(text) || BULLET.test(text) || /^\d/.test(text)) return null;
  if (SINGLE_SYLLABLE.test(text) || UNIT_WORDS.has(text) || DATE_UNITS.has(text)) return null;
  return looksLikeLabel(text) ? text : null;
}

// ---- rules -------------------------------------------------------------------

const range = (line, i, j) => ({ start: line[i].pos, end: line[j - 1].pos + 1 });

function blanksInLine(line, appendAt) {
  const text = line.map((c) => c.ch).join('');
  const used = new Set();
  const free = (i, j) => { for (let x = i; x < j; x++) if (used.has(x)) return false; return true; };
  const take = (i, j) => { for (let x = i; x < j; x++) used.add(x); };
  const out = [];

  // Dates with units: "20   년     월     일"; any part may already be written.
  for (const m of text.matchAll(/(\d{0,4})([ \u3000]*)년([ \u3000]*)(\d{0,2})([ \u3000]*)월([ \u3000]*)(\d{0,2})([ \u3000]*)일/dg)) {
    const [, y, ys, , mm, , , dd] = m;
    const I = m.indices;
    const parts = [];
    if (y.length < 4 && (y ? ys.length >= 1 : ys.length >= 2)) parts.push({ ...range(line, I[2][0], I[2][1]), role: 'year', align: y ? 'left' : 'right', prefix: y || undefined });
    if (!mm && m[3].length + m[5].length >= 2) parts.push({ ...range(line, I[3][0], I[5][1]), role: 'month', align: 'right' });
    if (!dd && m[6].length + m[8].length >= 2) parts.push({ ...range(line, I[6][0], I[8][1]), role: 'day', align: 'right' });
    if (!parts.length) continue;
    take(I[0][0], I[0][1]);
    const after = text.slice(I[0][1]);
    const period = /^\s*(부터|까지)/.exec(after)?.[1];
    const born = /^\s*생(?!산)/.test(after);
    out.push({ kind: 'date', display: born ? ['생년월일'] : [...labelBefore(text, I[0][0]), ...(period ? [period] : [])], parts });
  }
  // Dates with dots: "20  .   .    ."
  for (const m of text.matchAll(/(?<![\d.])((?:19|20)?)([ \u3000]+)\.([ \u3000]+)\.([ \u3000]+)\.?/dg)) {
    const I = m.indices;
    if (!m[1] && m[2].length < 2) continue;
    if (!free(I[0][0], I[0][1])) continue;
    take(I[0][0], I[0][1]);
    const born = /^\s*생/.test(text.slice(I[0][1]));
    out.push({
      kind: 'date',
      display: born ? ['생년월일'] : labelBefore(text, I[0][0]),
      parts: [
        { ...range(line, I[2][0], I[2][1]), role: 'year', align: m[1] ? 'left' : 'right', prefix: m[1] || undefined },
        { ...range(line, I[3][0], I[3][1]), role: 'month', align: 'right' },
        { ...range(line, I[4][0], I[4][1]), role: 'day', align: 'right' },
      ],
    });
  }
  // Numbers in parts: "주민등록번호        -         " (two or three parts).
  for (const m of text.matchAll(/([ \u3000]{2,})-([ \u3000]{2,}|[ \u3000]*(?=[)）]|$))(?:-([ \u3000]{2,}|[ \u3000]*(?=[)）]|$)))?/dg)) {
    const I = m.indices;
    const label = SPLIT_LABEL.exec(text.slice(0, I[0][0]).replace(/[(（]\s*$/, ''));
    if (!label || !free(I[0][0], I[0][1])) continue;
    take(I[0][0], I[0][1]);
    // A last part of no spaces (the line ends after "-") is written after the dash.
    const at = (a, b) => (a < b ? range(line, a, b) : { start: line[a - 1].pos + 1, end: line[a - 1].pos + 1 });
    // Each part sits against the dash: parts before a dash to the right, the last to the left.
    const spans = [I[1], I[2], I[3]].filter(Boolean);
    out.push({ kind: 'split', display: [label[1]], parts: spans.map(([a, b], n) => ({ ...at(a, b), role: 'part', align: n < spans.length - 1 ? 'right' : 'left' })) });
  }

  const toks = tokenize(line);
  toks.forEach((t, k) => {
    if (!t.run || t.weight < 2 || !free(t.i, t.j)) return;
    const name = nameFor(toks, k);
    if (name) out.push({ kind: 'text', display: name.display, parts: [{ ...range(line, t.i, t.j), role: 'value', align: name.align ?? 'left' }] });
  });

  // "주소:" or "(주소)" ending the paragraph, with nothing but spacing before it.
  if (appendAt !== null) {
    const words = toks.filter((x) => !x.run);
    if (words.length === 1) {
      const w = words[0].text;
      const name = SIGN_MARK.test(w) ? null : /^[(（](.+)[)）]$/.exec(w)?.[1] ?? /^(.+)[:：]$/.exec(w)?.[1] ?? null;
      if (name && usableLabel(name) && toks[toks.length - 1] === words[0]) {
        out.push({ kind: 'append', display: [name], parts: [{ start: appendAt, end: appendAt, role: 'value', align: 'left' }] });
      }
    }
  }
  return out;
}

/** The label of the run of spacing at token k, or null when the run is layout. */
function nameFor(toks, k) {
  const L = toks[k - 1];
  const R = toks[k + 1];
  const rWord = R && !R.run ? R.text : null;
  const unit = rWord?.replace(/[,.]$/, '');

  if (!L) {
    // Indentation, unless a unit follows: "    은행 …", or "    원" ending the line.
    const fits = unit && UNIT_WORDS.has(unit) && (unit.length > 1 || !toks[k + 2]);
    return fits ? { display: [unit], align: 'right' } : null;
  }
  const lw = L.text;
  // "제    호"
  if (lw === '제' && rWord && ORDINAL_UNITS.has(rWord[0])) return { display: ['제' + rWord[0]] };
  // "(성명:        )", "기타(      )", "전화번호(        )"
  if (rWord && /^[)）]/.test(rWord)) {
    const open = /[(（]([^()（）]*?)\s*[:：]?$/.exec(lw);
    if (open?.[1] && looksLikeLabel(open[1])) return { display: [open[1]] };
    if (open) {
      const before = lw.slice(0, open.index).replace(/^[□■○●◦※*\-·•▪]+/, '');
      if (before && looksLikeLabel(before)) return { display: [before] };
      return null;
    }
    const inside = labelPhrase(toks, k - 1); // "(연락 가능한 전화번호:      )"
    return inside ? { display: [inside] } : null;
  }
  // Before a signature mark: "작성자 :            (서명)", "신청인         (서명 또는 날인)"
  if (rWord && SIGN_MARK.test(bracketFrom(toks, k + 1))) {
    const p = labelPhrase(toks, k - 1);
    return p ? { display: [p] } : null;
  }
  // After a colon: "성명:          ..."
  if (/[:：]$/.test(lw)) {
    const p = labelPhrase(toks, k - 1);
    return p ? { display: [p] } : null;
  }
  // After a bracketed label, before another one or the end: "(성명)           (주민등록번호"
  const paren = /^[(（]([^()（）]+)[)）]$/.exec(lw);
  if (paren && !SIGN_MARK.test(lw) && looksLikeLabel(paren[1]) && (!R || /^[(（]/.test(rWord ?? ''))) return { display: [paren[1]] };
  // Before a unit: "보증금        원", "송금받을         은행"
  if (unit && UNIT_WORDS.has(unit) && !(SINGLE_SYLLABLE.test(lw) && !/\d/.test(lw))) {
    // "보증금 [ ] 원" needs its context; "[ ] 은행" names itself.
    const before = unit.length === 1 && !UNIT_WORDS.has(lw) ? labelPhrase(toks, k - 1) : null;
    return { display: before ? [before, unit] : [unit], align: 'right' };
  }
  // A label ending the line: "등록기준지        "
  if (!R && !/[.。!?)）]$/.test(lw)) {
    const p = labelPhrase(toks, k - 1);
    return p ? { display: [p] } : null;
  }
  return null;
}

/** A label written just before a date ("신고연월일 20  년 ..."). */
function labelBefore(text, at) {
  const before = text.slice(0, at).replace(/[ \u3000:：]+$/, '').trim();
  if (/(?:^|[\s\d])일$|부터$|까지$|[,，~∼]$/.test(before)) return []; // the end of another date or a range
  const last = (before.split(/[ \u3000]{2,}/).pop() ?? '').replace(/^[(（]|[)）]$/g, '');
  return usableLabel(last) ? [last] : [];
}

// ---- filling -------------------------------------------------------------------


const IS_SPACE = /[ \u3000\u00a0]/;
const NO_LEAD_AFTER = /[(（\[\-~∼/]/;
const NO_TRAIL_BEFORE = /[)）\],.，。:：\-~∼/]/;

/** "2026-10-09", "2026.10.9", "2026년 10월 9일", "20261009", "today"/"오늘" → { year, month, day }. */
export function parseDate(value, today = new Date()) {
  const v = String(value).trim();
  if (/^(today|오늘)$/i.test(v)) return { year: String(today.getFullYear()), month: String(today.getMonth() + 1), day: String(today.getDate()) };
  let m = /^(\d{4})\D+(\d{1,2})(?:\D+(\d{1,2}))?\D*$/.exec(v) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (!m) throw new RangeError(`not a date: ${JSON.stringify(v)}`);
  const [, year, month, day] = m;
  return { year, month: String(Number(month)), day: day ? String(Number(day)) : null };
}

/** A number written in parts ("900101-1234567"): the part values, in order. */
export function splitValue(value, n, label = '') {
  const v = String(value).trim();
  if (v.includes('-')) {
    const parts = v.split('-');
    while (parts.length > n) parts.splice(n - 1, 2, parts[n - 1] + '-' + parts[n]);
    return [...parts, ...Array(n - parts.length).fill(null)];
  }
  const digits = v.replace(/\s/g, '');
  const cuts = n === 2 && digits.length === 13 ? [6] // 주민등록번호 and the like
    : n === 3 && /사업자/.test(label) && digits.length === 10 ? [3, 5]
      : n === 3 && digits.length >= 9 && digits.length <= 11 ? [digits.startsWith('02') ? 2 : 3, digits.length - 4]
        : null;
  if (!cuts) return [v, ...Array(n - 1).fill(null)];
  const out = [];
  let at = 0;
  for (const c of cuts) { out.push(digits.slice(at, c)); at = c; }
  out.push(digits.slice(at));
  return out;
}

/** The value for each part of a blank, or null to leave that part blank. */
function partValues(blank, value) {
  const v = String(value).replace(/\r?\n/g, ' ');
  if (blank.kind === 'date') {
    const d = parseDate(v);
    return blank.parts.map((p) => {
      if (p.role === 'month') return d.month;
      if (p.role === 'day') return d.day;
      if (!p.prefix) return d.year;
      if (!d.year.startsWith(p.prefix)) throw new RangeError(`year ${d.year} does not continue the printed "${p.prefix}"`);
      return d.year.slice(p.prefix.length);
    });
  }
  if (blank.kind === 'split') return splitValue(v, blank.parts.length, blank.display[0] ?? '');
  return [v];
}

/**
 * Text for one blank part: the value, with the spacing that keeps the blank's
 * printed width (so what follows stays in place) and one space between the
 * value and neighbouring words. Widths are in HWPUNIT: `blankWidth` is the
 * blank as printed (each character in its own style), `style` the one the
 * new text takes, `carry` width owed by an earlier part.
 */
function compose(part, value, blankWidth, prev, next, style, carry) {
  const sp = advance(' ', style) * sizeOf(style);
  const word = (c) => c && !IS_SPACE.test(c);
  const lead = part.align === 'left' && !part.prefix && word(prev) && !NO_LEAD_AFTER.test(prev) ? ' ' : '';
  const trail = word(next) && !NO_TRAIL_BEFORE.test(next) ? ' ' : '';
  const room = blankWidth + carry - absWidth(lead + value + trail, style);
  if (part.prefix || part.end === part.start) {
    // Nothing may come between "20" and "26"; an appended value has no room to keep.
    return { text: (part.end === part.start && word(prev) ? ' ' : '') + value, carry: part.prefix ? room : 0 };
  }
  const pad = Math.max(0, Math.round(room / sp));
  const rest = room - pad * sp;
  if (part.align === 'left') return { text: lead + value + ' '.repeat(pad) + trail, carry: rest };
  const sep = pad === 0 && word(prev) && !NO_LEAD_AFTER.test(prev) ? ' ' : '';
  return { text: ' '.repeat(pad) + sep + value + trail, carry: rest };
}

/**
 * Edits that write `value` into `blank`: [{ start, end, text }] in paragraph
 * positions, last first (so each can be applied in turn).
 * @param {(pos: number) => object|null} styleAt character style at a position
 */
export function blankEdits(paragraph, blank, value, styleAt = () => null) {
  const { chars } = paragraphChars(paragraph);
  const at = new Map(chars.map((c) => [c.pos, c]));
  const values = partValues(blank, value);
  const edits = [];
  let carry = 0;
  blank.parts.forEach((part, i) => {
    const v = values[i];
    if (v === null || v === undefined) { carry = 0; return; }
    // The blank's printed width: each character in the style it has (a blank
    // can change style part-way, e.g. underlined spaces then plain ones).
    let blankWidth = 0;
    for (let p = part.start; p < part.end; p++) blankWidth += absWidth(at.get(p)?.ch ?? ' ', styleAt(p));
    const prev = at.get(part.start - 1);
    const next = at.get(part.end);
    const style = styleAt(part.start < part.end ? part.start : Math.max(0, part.start - 1));
    const out = compose(part, v, blankWidth, prev?.sep ? null : prev?.ch, next?.sep ? null : next?.ch, style, carry);
    carry = out.carry;
    edits.push({ start: part.start, end: part.end, text: out.text });
  });
  return edits.reverse();
}
