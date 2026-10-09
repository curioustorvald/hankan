// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Free edits of a form's own text: placeholders and notes the form prints
// ("OOO", "20OO. OO. OO.", "※대량일 경우 뒤쪽 사용") that the slot finder
// does not offer, changed by hand.
//
// An edit names a stretch of plain text (no controls inside) in one
// paragraph by its position in the original document, and carries the text
// it expects to find there:
//
//   { p, start, end, from, to }
//
// `p` indexes the paragraphs in document order (paragraphList). Positions
// are moved past earlier edits of the same paragraph (slot fills or other
// text edits); an edit whose text is no longer what it expects is refused
// rather than applied in the wrong place. Only the characters that differ
// are replaced, so the rest keep their bytes and character shapes; new
// text takes the shape of the character before it, as typing does.
//
// Coloured text (placeholders are often red) that is edited turns black:
// the whole stretch gets black copies of its character shapes (colour.js).

import { recordEdit } from './slots.js';
import { recolour } from './colour.js';

/** The paragraphs of a document in order; an edit's `p` is an index into this. */
export function paragraphList(doc) {
  return [...doc.walk()].map((w) => w.paragraph);
}

/** Text as a paragraph will hold it: CR LF and CR become LF, tabs spaces, other control characters dropped. */
export function cleanText(text) {
  return String(text).replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0009\u000b-\u001f]/g, '');
}

/**
 * The changes that turn `a` into `b`, as [{ start, end, text }] ranges of
 * `a` (UTF-16 offsets, in order, never splitting a surrogate pair). Each
 * range is a run of changed characters; characters both strings share are
 * left out.
 */
export function textDiff(a, b) {
  const A = Array.from(a);
  const B = Array.from(b);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a1 = A.slice(pre, A.length - suf);
  const b1 = B.slice(pre, B.length - suf);
  // Hunks in code points of the trimmed strings.
  const hunks = a1.length * b1.length > 1_000_000
    ? [{ i: 0, j: a1.length, k: 0, l: b1.length }] // too long to align: one change
    : align(a1, b1);
  // Code point index -> UTF-16 offset in `a`.
  const offset = [0];
  for (const ch of A) offset.push(offset[offset.length - 1] + ch.length);
  return hunks
    .filter((h) => h.i !== h.j || h.k !== h.l)
    .map((h) => ({ start: offset[pre + h.i], end: offset[pre + h.j], text: b1.slice(h.k, h.l).join('') }));
}

/** Longest common subsequence alignment of two arrays, as the runs that differ. */
function align(a, b) {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const L = new Uint32Array((n + 1) * w); // L[i][j]: LCS length of a[i..] and b[j..]
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  const hunks = [];
  let cur = null;
  let i = 0;
  let j = 0;
  const open = () => (cur ??= { i, j: i, k: j, l: j });
  const close = () => { if (cur) { hunks.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { close(); i++; j++; continue; }
    open();
    if (j < m && (i === n || L[i * w + j + 1] >= L[(i + 1) * w + j])) { j++; cur.l = j; } else { i++; cur.j = i; }
  }
  close();
  return hunks;
}

/** Where `pos` is after the edits in `log`: the start of a stretch moves past text inserted at it, the end does not. */
function mapPoint(pos, log, side) {
  for (const { start, end, length } of log) {
    const delta = length - (end - start);
    if (side === 'start' ? pos >= end : pos >= end && pos > start) pos += delta;
    else if (pos > start && pos < end) throw new RangeError('the text was changed by a fill');
  }
  return pos;
}

/** The plain text of [start, end) of a paragraph; a control inside it throws. */
function plainText(paragraph, start, end) {
  let text = '';
  let at = start;
  for (const u of paragraph.units()) {
    if (u.end <= start || (u.type === 'end' && u.pos === start && start === end)) continue;
    if (u.pos >= end) break;
    if (u.type !== 'text' || u.pos > at) throw new RangeError(`[${start}, ${end}) is not plain text`);
    text += u.text.slice(Math.max(0, start - u.pos), end - u.pos);
    at = u.end;
  }
  if (at < end) throw new RangeError(`[${start}, ${end}) is past the paragraph`);
  return text;
}

/**
 * Apply text edits to a document. An edit that cannot be applied is
 * reported and leaves its paragraph as it was.
 * @param {object} doc
 * @param {Array<{ p: number, start: number, end: number, from: string, to: string }>} edits
 * @param {{ lineSegs?: 'drop'|'keep' }} [options]
 */
export function applyTextEdits(doc, edits, { lineSegs = 'drop' } = {}) {
  const report = { applied: [], failed: [], warnings: [] };
  if (!edits?.length) return report;
  const paragraphs = paragraphList(doc);
  for (const edit of edits) {
    try {
      const paragraph = paragraphs[edit.p];
      if (!paragraph) throw new RangeError(`there is no paragraph ${edit.p}`);
      const log = paragraph._editLog ?? [];
      const start = mapPoint(edit.start, log, 'start');
      const end = mapPoint(edit.end, log, 'end');
      const now = plainText(paragraph, start, end);
      if (now !== edit.from) throw new RangeError(`expected ${JSON.stringify(edit.from)}, found ${JSON.stringify(now)}`);
      const to = cleanText(edit.to);
      const hunks = textDiff(edit.from, to).map((h) => {
        if (h.start !== h.end || h.start === 0) return h;
        // An insertion goes in with the character before it, so that it takes that character's shape.
        const prev = Array.from(edit.from.slice(0, h.start)).pop();
        return { start: h.start - prev.length, end: h.end, text: prev + h.text };
      });
      // A reserved character control shows as U+FFFD; replacing it would turn it into text.
      if (hunks.some((h) => edit.from.slice(h.start, h.end).includes('\ufffd'))) throw new RangeError('the edit would remove a special character');
      for (const h of hunks.reverse()) {
        paragraph.replaceRange(start + h.start, start + h.end, h.text, { lineSegs });
        recordEdit(paragraph, start + h.start, start + h.end, h.text.length);
      }
      report.applied.push(edit);
      try {
        recolour(doc, paragraph, start, start + to.length);
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        report.warnings.push({ edit, error: `colour left as it was: ${e.message}` });
      }
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      report.failed.push({ edit, error: e.message });
    }
  }
  return report;
}
