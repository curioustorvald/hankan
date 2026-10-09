// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// A plain outline of a document for showing it on screen: paragraphs (with
// alignment and bold runs) and tables (with merged cells), and where each
// slot sits in them. Not a layout: positions on the page are not computed.
//
//   { type: 'p', align, segments: [{ text, bold, color?, p?, start?, end? } | { slot, option?, size }] }
//   { type: 'table', rows, cols, cells: [{ row, col, rowSpan, colSpan, slot?, blocks }] }
//
// `size` is the number of code units the slot covers, as a hint for how
// wide to draw it. `color` ('#rrggbb') is given for coloured text only
// (colour.js); segments split where it changes. A text segment with `p` is
// a stretch of plain text that can be edited (edit.js): paragraph `p`
// (paragraphList order), code units [start, end). An empty paragraph has
// one such segment with no text, where text can be put in, if it has a
// character style for the text to take. Tabs have no range.

import { paragraphList } from './edit.js';
import { isColoured } from './colour.js';

/** Where each slot sits: paragraph -> ranges, and cell list -> cell slot. */
function slotMarks(slots) {
  const marks = new Map();
  const cells = new Map();
  const add = (paragraph, mark) => {
    if (!marks.has(paragraph)) marks.set(paragraph, []);
    marks.get(paragraph).push(mark);
  };
  for (const s of slots) {
    if (s.kind === 'cell') {
      cells.set(s._cell.list, s);
    } else if (s.kind === 'field') {
      const r = s._range();
      add(r.paragraph, { start: r.start, end: r.end, slot: s.id });
    } else if (s.kind === 'blank') {
      const parts = s._blank.parts;
      add(s._paragraph, { start: parts[0].start, end: parts[parts.length - 1].end, slot: s.id });
    } else if (s.kind === 'choice') {
      s._options.forEach((o, i) => {
        const [start, end] = o.kind === 'char' ? [o.pos, o.pos + 1] : o.kind === 'form' ? [o.pos, o.pos + 8] : [o.pos, o.end + 1];
        add(o.paragraph, { start, end, slot: s.id, option: i });
      });
    }
  }
  for (const list of marks.values()) list.sort((a, b) => a.start - b.start || a.end - b.end);
  return { marks, cells };
}

export function documentOutline(doc, slots) {
  const { marks, cells } = slotMarks(slots);
  const index = new Map(paragraphList(doc).map((p, i) => [p, i]));
  const ctx = { doc, marks, cells, index };
  const blocks = [];
  for (const section of doc.sections) {
    for (const p of section.paragraphs) blocks.push(...paragraphBlocks(ctx, p));
  }
  return blocks;
}

function paragraphBlocks(ctx, p) {
  const { doc, marks, index } = ctx;
  const out = [];
  const tables = [];
  const segments = [];
  const pending = [...(marks.get(p) ?? [])];
  const styleAt = (pos) => (doc.charStyleAt ? doc.charStyleAt(p, pos) : null);
  const pi = index.get(p);
  let skipUntil = -1;
  let endPos = 0;
  // Characters join the segment before them only where nothing lies between.
  const pushText = (ch, pos) => {
    const style = styleAt(pos);
    const b = !!style?.bold;
    const color = isColoured(style?.color) ? style.color : undefined;
    const last = segments[segments.length - 1];
    if (last && last.end === pos && last.bold === b && last.color === color) { last.text += ch; last.end = pos + 1; return; }
    segments.push({ text: ch, bold: b, ...(color ? { color } : {}), p: pi, start: pos, end: pos + 1 });
  };
  const emitMarksAt = (pos) => {
    while (pending.length && pending[0].start <= pos) {
      const m = pending.shift();
      const size = m.end - m.start;
      segments.push(m.option === undefined ? { slot: m.slot, size } : { slot: m.slot, option: m.option, size });
      skipUntil = Math.max(skipUntil, m.end);
    }
  };
  for (const u of p.units()) {
    if (u.type === 'end') { endPos = u.pos; emitMarksAt(u.pos); break; }
    if (u.type === 'control') {
      emitMarksAt(u.pos);
      if (u.pos < skipUntil) continue;
      if (u.control?.cells) tables.push(u.control);
      else if (u.code === 9) segments.push({ text: '\t', bold: false });
      continue;
    }
    for (let i = 0; i < u.text.length; i++) {
      const pos = u.pos + i;
      emitMarksAt(pos);
      if (pos < skipUntil) continue;
      pushText(u.text[i], pos);
    }
  }
  emitMarksAt(Infinity);
  if (!segments.length && !tables.length && p.canHoldText) segments.push({ text: '', bold: false, p: pi, start: endPos, end: endPos });
  if (segments.length || !tables.length) out.push({ type: 'p', align: doc.paraAlign ? doc.paraAlign(p) : 'left', segments });
  for (const t of tables) out.push(tableBlock(ctx, t));
  return out;
}

function tableBlock(ctx, table) {
  return {
    type: 'table',
    rows: table.rows,
    cols: table.cols,
    cells: table.cells.map((c) => {
      const slot = ctx.cells.get(c.list);
      return {
        row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan,
        ...(slot ? { slot: slot.id } : {}),
        blocks: slot ? [] : c.paragraphs.flatMap((p) => paragraphBlocks(ctx, p)),
      };
    }),
  };
}
