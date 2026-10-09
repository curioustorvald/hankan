// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Finding the places a form expects to be filled ("slots"), independently
// of the file format. Three kinds are recognised from document structure
// alone, without rendering:
//
//   cell   an empty table cell, named by the label cells around it
//          (to its left, the column header above it, or a question above);
//   field  a click-here field (누름틀) whose content lies in one paragraph,
//          named by its cell context, the text before it, its field name
//          or its guide text;
//   blank  spaces left for writing inside running text (inline.js), named
//          by the words around them, the label opening the paragraph or the
//          cell they are in;
//   choice check boxes written as characters (choice.js), named by the words
//          before them, their cell, or the heading above a list of them.
//
// The format modules provide the structure (tables with cell addresses and
// spans, paragraphs as units, fields); see hwp5/section.js and
// hwpx/section.js for the clauses they rest on.

import { normaliseLabel, looksLikeLabel } from './labels.js';
import { FIELD_BEGIN, FIELD_END } from '../hwp5/paragraph.js';
import { findInlineBlanks, leadLabel, paragraphChars, blankEdits } from './inline.js';
import { findChoiceLines, chooseOptions, FILLED, markFor } from './choice.js';
import { recolour } from './colour.js';
import { advance, absWidth, sizeOf } from './width.js';

/**
 * @typedef {object} Slot
 * @property {string} id       stable id within the document (t<table>.r<row>c<col>, f<n>, or p<paragraph>.b<n>)
 * @property {'cell'|'field'|'blank'|'choice'} kind
 * @property {string[]} [options] the options of a choice
 * @property {'text'|'date'|'split'|'append'} [blank] the kind of an inline blank
 * @property {string[]} labels normalised labels, outermost first
 * @property {string[]} display the label texts as printed
 * @property {number} index    1 for the first blank of its label; 2, 3, ... for repeated rows or blanks
 * @property {string|null} group title of the table section the slot belongs to
 * @property {string} key      unique readable name, e.g. "성명.한글" or "자격증#2"
 * @property {string} value    current content (empty for a blank or an untouched field)
 * @property {string|null} hint guide text of a field
 */

export function findSlots(doc) {
  const slots = [];
  const tableIndex = new Map();
  const cellSlot = new Map(); // cell -> slot (cells holding a field are named through it)
  let fieldCount = 0;
  let paragraphIndex = 0;
  const leads = new Map(); // paragraph list -> label opening the latest paragraph, for continuation lines
  const labelCells = new Set(); // cells that name a neighbouring blank cell
  const choices = new ChoiceCollector(slots, doc);

  for (const { paragraph, path } of doc.walk()) {
    const pIndex = paragraphIndex++;
    for (const control of paragraph.controls) {
      if (control.cells && !tableIndex.has(control)) {
        const t = tableIndex.size;
        tableIndex.set(control, t);
        for (const slot of tableSlots(control, t)) {
          slots.push(slot);
          cellSlot.set(slot._cell, slot);
          for (const c of slot._labelCells) labelCells.add(c);
        }
      }
    }
    for (const span of fieldSpans(paragraph)) {
      if (span.field.kind !== 'clickhere') continue;
      // A field holding other controls (e.g. nested fields) is not a blank of its own.
      const inner = paragraph.units().filter((u) => u.pos >= span.begin.end && u.end <= span.end.pos);
      if (inner.some((u) => u.type === 'control' && u.code !== 9)) continue;
      slots.push(fieldSlot(span, paragraph, path, fieldCount++));
    }
    // Text in a cell that labels the empty cell next to it is a label, not a blank.
    const step = path[path.length - 1];
    const inLabelCell = step?.control.cells && labelCells.has(step.control.cells.find((c) => c.list === step.list));
    const choiceLines = findChoiceLines(paragraph);
    // A bracket box ("예 (    )") is a choice, not a blank to write in.
    const boxes = choiceLines.flatMap((l) => l.options.filter((o) => o.kind === 'bracket' || o.kind === 'paren').map((o) => [o.pos, o.end + 1]));
    if (!inLabelCell) slots.push(...blankSlots(doc, paragraph, path, pIndex, leads, boxes));
    choices.add(paragraph, path, pIndex, choiceLines);
  }
  choices.flushAll();
  assignKeys(slots);
  for (const s of slots) Object.defineProperty(s, '_doc', { value: doc });
  return slots;
}

// ---- tables ----------------------------------------------------------------

function tableSlots(table, t) {
  const grid = new Map();
  for (const cell of table.cells) {
    for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
      for (let c = cell.col; c < cell.col + cell.colSpan; c++) grid.set(r * 65536 + c, cell);
    }
  }
  const at = (r, c) => (r < 0 || c < 0 ? null : grid.get(r * 65536 + c) ?? null);
  const info = new Map(table.cells.map((cell) => [cell, describeCell(cell, table)]));
  const out = [];
  for (const cell of table.cells) {
    const me = info.get(cell);
    if (!me.empty) continue;
    const naming = nameCell(cell, table, at, info);
    out.push(makeCellSlot(cell, t, naming, me));
  }
  return out;
}

function describeCell(cell, table) {
  const text = cell.paragraphs.map((p) => p.text).join('\n');
  let controls = 0;
  let outside = '';
  let fields = 0;
  for (const p of cell.paragraphs) {
    const spans = fieldSpans(p).filter((s) => s.field.kind === 'clickhere');
    fields += spans.length;
    const inField = (u) => spans.some((s) => u.pos >= s.begin.pos && u.end <= s.end.end);
    for (const u of p.units()) {
      if (inField(u)) continue;
      if (u.type === 'control') controls++;
      else if (u.type === 'text') outside += u.text;
    }
  }
  const empty = controls === 0 && fields === 0 && text.trim() === '' && cell.paragraphs.length > 0;
  return {
    text,
    empty,
    // Holds click-here fields and nothing else: a blank for naming purposes.
    blank: empty || (fields > 0 && controls === 0 && outside.trim() === ''),
    // A cell of check boxes is a choice, not a label for its neighbours.
    label: fields === 0 && controls === 0 && !empty && looksLikeLabel(text) && !/[□☐▢◻]/.test(text),
    title: cell.colSpan === table.cols && table.cols > 1,
  };
}

/** Labels for an empty (or field-holding) cell from the cells around it. */
function nameCell(cell, table, at, info) {
  const labelAt = (c) => c && info.get(c).label && !info.get(c).title;

  // Labels to the left, nearest first; blanks in between count as further blanks of that label.
  const left = [];
  let skippedLeft = 0;
  for (let c = at(cell.row, cell.col - 1); c;) {
    const d = info.get(c);
    if (labelAt(c)) left.push(c);
    else if (d.blank && !left.length) skippedLeft++;
    else break;
    c = at(cell.row, c.col - 1);
    if (left.length && c && !labelAt(c)) break;
  }

  // The column header above, passing over blank rows (repeated records).
  let header = null;
  let skippedUp = 0;
  for (let c = at(cell.row - 1, cell.col); c; c = at(c.row - 1, cell.col)) {
    const d = info.get(c);
    if (d.title) break;
    if (labelAt(c)) { header = c; break; }
    if (d.blank && c.col === cell.col && c.colSpan === cell.colSpan) { skippedUp++; continue; }
    break;
  }

  const group = groupTitle(cell, at, info);

  // Grid: a header row of several labels, and a label opening this row
  // (blank rows between the header and this row are other rows of the grid).
  if (header) {
    const headerRow = table.cells.filter((c) => c.row === header.row);
    const headerRowLabels = headerRow.filter((c) => labelAt(c)).length;
    const isHeaderRow = headerRowLabels >= 2 && headerRow.every((c) => !info.get(c).blank);
    const rowHead = at(cell.row, 0);
    if (isHeaderRow && labelAt(rowHead) && rowHead.row > header.row) {
      return { cells: [rowHead, header], index: 1, group };
    }
  }
  if (left.length) return { cells: left.reverse(), index: skippedLeft + 1, group };
  if (header) return { cells: [header], index: skippedUp + 1, group };

  // A question or instruction directly above, spanning the same columns.
  const above = at(cell.row - 1, cell.col);
  if (above && !info.get(above).empty && above.col === cell.col && above.colSpan === cell.colSpan && !info.get(above).title) {
    return { cells: [above], index: 1, group, question: true };
  }
  return { cells: [], index: 1, group };
}

/** The nearest full-width title row above, read as a short heading. */
function groupTitle(cell, at, info) {
  for (let r = cell.row - 1; r >= 0; r--) {
    const c = at(r, cell.col);
    if (!c || !info.get(c).title || info.get(c).empty) continue;
    const heading = headingOf(info.get(c).text);
    if (heading) return heading;
    r = c.row; // skip the rest of a tall title cell
  }
  return null;
}

/** "□ 경력 사항 : 지원한 직무와 …" → "경력 사항"; notes ("* …", "※ …") are not headings. */
function headingOf(text) {
  const line = firstLine(text);
  if (/^[*※]/.test(line)) return null;
  const head = line.replace(/^[□■○●◦▪•·\-–—\s]+/, '').split(/\s*[:：(（]/)[0].trim();
  return head && looksLikeLabel(head) ? head : null;
}

function makeCellSlot(cell, t, naming, me) {
  const texts = naming.cells.map((c) => c.paragraphs.map((p) => p.text).join(' '));
  const display = texts.map((x) => (naming.question ? shorten(x) : x.replace(/\s+/g, ' ').trim()));
  return {
    id: `t${t}.r${cell.row}c${cell.col}`,
    kind: 'cell',
    labels: display.map(normaliseLabel),
    display,
    index: naming.index,
    group: naming.group,
    key: '',
    value: me.text.trim(),
    hint: null,
    _cell: cell,
    _labelCells: naming.cells,
    _range() {
      const p = cell.paragraphs[0];
      const units = p.units();
      return { paragraph: p, start: 0, end: units[units.length - 1].pos };
    },
  };
}

// ---- fields ----------------------------------------------------------------

/** Field begin/end pairs within one paragraph (fields nest; ends match the latest open begin). */
export function fieldSpans(paragraph) {
  const spans = [];
  const open = [];
  for (const u of paragraph.units()) {
    if (u.type !== 'control') continue;
    if (u.code === FIELD_BEGIN && u.control) open.push(u);
    else if (u.code === FIELD_END && open.length) {
      const begin = open.pop();
      spans.push({ field: begin.control, begin, end: u });
    }
  }
  return spans;
}

function fieldSlot(span, paragraph, path, n) {
  const { field } = span;
  const hint = field.direction || null;
  let labels = [];
  let display = [];
  let index = 1;
  let group = null;

  // Inside a table cell: name it like the cell.
  const context = cellContext(path);
  if (context) ({ display, index, group } = context);
  // Text just before the field in its paragraph, e.g. "성명: [field]".
  if (!display.length) {
    const before = paragraph.units().filter((u) => u.type === 'text' && u.end <= span.begin.pos).map((u) => u.text).join('');
    const m = /([^\s:：()]+)\s*[:：]?\s*$/.exec(before);
    if (m && looksLikeLabel(m[1])) display = [m[1]];
  }
  if (!display.length && field.name && !/[/_]|^[A-Za-z0-9]+$/.test(field.name)) display = [field.name];
  if (!display.length && hint) display = [hint];
  labels = display.map(normaliseLabel);

  const content = paragraph.units()
    .filter((u) => u.type === 'text' && u.pos >= span.begin.end && u.end <= span.end.pos)
    .map((u) => u.text).join('');
  return {
    id: `f${n}`,
    kind: 'field',
    labels,
    display,
    index,
    group,
    key: '',
    value: field.dirty ? content : '',
    hint,
    name: field.name,
    _field: field,
    _range() {
      const s = fieldSpans(paragraph).find((x) => x.field === field);
      if (!s) throw new Error(`field ${n} no longer found`);
      // An untouched field holds its guide text in a guide style; a value
      // takes the style of the field itself (PROVENANCE.md, C9).
      return { paragraph, start: s.begin.end, end: s.end.pos, styleOf: field.dirty ? null : s.begin.pos };
    },
  };
}

// ---- naming ------------------------------------------------------------------

/** Unique readable keys: labels joined by '.', then '#n' for repeats, then the group or id. */
function assignKeys(slots) {
  for (const s of slots) {
    const base = s.labels.filter(Boolean).join('.') || s.id;
    s.key = s.index > 1 ? `${base}#${s.index}` : base;
  }
  const count = (list) => list.reduce((m, s) => m.set(s.key, (m.get(s.key) ?? 0) + 1), new Map());
  let dup = count(slots);
  for (const s of slots) {
    if (dup.get(s.key) > 1 && s.group) s.key = `${normaliseLabel(s.group)}.${s.key}`;
  }
  dup = count(slots);
  const seen = new Map();
  for (const s of slots) {
    if (dup.get(s.key) > 1) {
      const n = (seen.get(s.key) ?? 0) + 1;
      seen.set(s.key, n);
      s.key = `${s.key}@${n}`;
    }
  }
}

function firstLine(text) {
  return text.split('\n').map((l) => l.trim()).find(Boolean)?.replace(/\s+/g, ' ') ?? '';
}

function shorten(text) {
  const t = firstLine(text);
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
}

/** How the table cell holding a paragraph is named by its neighbours, or null outside tables. */
function cellContext(path) {
  const inCell = [...path].reverse().find((step) => step.control.cells);
  if (!inCell) return null;
  const table = inCell.control;
  const cell = table.cells.find((c) => c.list === inCell.list);
  if (!cell) return null;
  const grid = new Map();
  for (const c of table.cells) for (let r = c.row; r < c.row + c.rowSpan; r++) for (let k = c.col; k < c.col + c.colSpan; k++) grid.set(r * 65536 + k, c);
  const at = (r, c) => (r < 0 || c < 0 ? null : grid.get(r * 65536 + c) ?? null);
  const info = new Map(table.cells.map((c) => [c, describeCell(c, table)]));
  const naming = nameCell(cell, table, at, info);
  return {
    display: naming.cells.map((c) => {
      const text = c.paragraphs.map((p) => p.text).join(' ');
      return naming.question ? shorten(text) : text.replace(/\s+/g, ' ').trim();
    }),
    index: naming.index,
    group: naming.group,
  };
}

// ---- blanks in running text ----------------------------------------------------

const UNIT_ONLY = new Set(['원', '명', '세', '부', '통', '건', '매', '회', '개', '장', '층', '시간', '개월', '일간', '주간', '년간', '%', '㎡', '㎞', '평', '살', '권', '쪽']);

function blankSlots(doc, paragraph, path, pIndex, leads, boxes = []) {
  const blanks = findInlineBlanks(paragraph)
    .filter((b) => !b.parts.some((p) => boxes.some(([s, e]) => p.start < e && s < Math.max(p.end, p.start + 1))));
  const listKey = path.length ? path[path.length - 1].list : 'body';
  // Context: the label opening this paragraph, or, for an indented
  // continuation line, the one opening the paragraph before.
  const { chars } = paragraphChars(paragraph);
  const firstLine = [];
  for (const c of chars) { if (c.sep) break; firstLine.push(c); }
  const own = leadLabel(firstLine);
  const indented = chars.length > 0 && /[ \u3000]/.test(chars[0].ch);
  if (own) leads.set(listKey, own);
  else if (!indented && chars.length) leads.delete(listKey);
  if (!blanks.length) return [];
  // Only a line that is just labels and blanks continues the one above ("      (주소)").
  const firstWord = firstLine.map((c) => c.ch).join('').trim().split(/[ \u3000]+/)[0] ?? '';
  const labelLine = blanks.some((b) => b.display.some((d) => firstWord.replace(/[(（):：）]/g, '') === d.replace(/\s/g, '')));
  const inherited = own ?? (indented && labelLine ? leads.get(listKey) ?? null : null);
  const cell = blanks.some((b) => !b.display.length || b.display.every((d) => UNIT_ONLY.has(d))) ? cellContext(path) : null;
  const styleAt = (pos) => (doc.charStyleAt ? doc.charStyleAt(paragraph, pos) : null);

  return blanks.map((b, n) => {
    let display = [...b.display];
    if (b.kind === 'date' && !display.length) display = ['날짜'];
    else if (b.kind === 'date' && display.every((d) => d === '부터' || d === '까지')) display = ['기간', ...display];
    if (cell && (!b.display.length || b.display.every((d) => UNIT_ONLY.has(d)))) display = [...cell.display, ...display];
    const lead = b.lead ?? inherited;
    if (lead && normaliseLabel(lead) !== normaliseLabel(display[0] ?? '')) display = [lead, ...display];
    const slot = {
      id: `p${pIndex}.b${n}`,
      kind: 'blank',
      blank: b.kind,
      labels: display.map(normaliseLabel).filter(Boolean),
      display,
      index: 1,
      group: cell?.group ?? null,
      key: '',
      value: '',
      hint: b.kind === 'date' ? 'YYYY-MM-DD' : b.kind === 'split' ? b.parts.map(() => '…').join('-') : null,
      _paragraph: paragraph,
      _blank: b,
      _fill(value, options = {}) {
        // Earlier fills in this paragraph moved the text; map the blank's positions forward.
        const log = paragraph._editLog ?? [];
        const parts = b.parts.map((p) => ({ ...p, start: mapPos(p.start, log.slice(b._seen ?? 0)), end: mapPos(p.end, log.slice(b._seen ?? 0)) }));
        const edits = blankEdits(paragraph, { ...b, parts }, value, styleAt);
        for (const e of edits) {
          paragraph.replaceRange(e.start, e.end, e.text, { lineSegs: options.lineSegs ?? 'drop' });
          recordEdit(paragraph, e.start, e.end, e.text.length);
          blackOver(doc, paragraph, e.start, e.start + e.text.length);
        }
      },
    };
    b._seen = paragraph._editLog?.length ?? 0;
    return slot;
  });
}

/** Text written over coloured text comes out black (colour.js); if that cannot be done, it keeps the colour. */
export function blackOver(doc, paragraph, start, end) {
  try {
    recolour(doc, paragraph, start, end);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }
}

/** Note an edit of [start, end) replaced by `length` code units, for blanks found before it. */
export function recordEdit(paragraph, start, end, length) {
  (paragraph._editLog ??= []).push({ start, end, length });
}

export function mapPos(pos, log) {
  for (const { start, end, length } of log) {
    if (pos >= end) pos += length - (end - start);
    else if (pos > start) throw new RangeError('blank overlaps an earlier edit');
  }
  return pos;
}

// ---- check boxes -----------------------------------------------------------------

/**
 * Turns the check-box lines of successive paragraphs into choice slots. A
 * line of options is one choice; single boxes opening successive lines
 * ("□ 주소 변동 없음" / "□ 송달장소") are one choice, named by the heading
 * line above them.
 */
class ChoiceCollector {
  constructor(slots, doc) {
    this.slots = slots;
    this.doc = doc;
    this.mark = null; // the mark bracket boxes take, found on first use
    this.pending = new Map(); // list -> { items, pIndex, path, heading }
    this.heading = new Map(); // list -> short label line seen last
    this.count = 0;
  }

  add(paragraph, path, pIndex, lines) {
    const key = path.length ? path[path.length - 1].list : 'body';
    if (!lines.length) {
      this.flush(key);
      const t = paragraph.text.trim().replace(/[:：]$/, '');
      if (t) this.heading.set(key, t.length <= 30 && looksLikeLabel(t) && !/[□☐▢◻■☑▣◼]/.test(t) ? t : null);
      return;
    }
    for (const line of lines) {
      if (line.item) {
        const p = this.pending.get(key) ?? { items: [], pIndex, path, heading: this.heading.get(key) ?? null };
        p.items.push(line);
        this.pending.set(key, p);
      } else {
        this.flush(key);
        this.emit([line], pIndex, path, line.label);
      }
    }
  }

  flush(key) {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    this.emit(p.items, p.pIndex, p.path, p.heading);
  }

  markChar() {
    this.mark ??= markFor([...this.doc.walk()].map((w) => w.paragraph.text));
    return this.mark;
  }

  flushAll() {
    for (const key of [...this.pending.keys()]) this.flush(key);
  }

  emit(lines, pIndex, path, label) {
    // The same options again ("(□ 공제 전 / □ 공제 후) … (□ 공제 전 / □ 공제 후)") are separate choices.
    let group = [];
    const seen = new Set();
    for (const o of lines.flatMap((l) => l.options)) {
      if (seen.has(o.label)) { this.emitGroup(group, pIndex, path, label); group = []; seen.clear(); }
      group.push(o);
      seen.add(o.label);
    }
    this.emitGroup(group, pIndex, path, label);
  }

  emitGroup(options, pIndex, path, label) {
    // "[지원구분] [☐ 신입] [☐ 경력]": a lone box in the cell right of the last
    // lone box of the same row joins that choice.
    const step = path[path.length - 1];
    const cell = step?.control.cells?.find((c) => c.list === step.list);
    const last = this.lastSingle;
    this.lastSingle = null;
    if (options.length === 1 && cell && last && last.table === step.control && last.cell.row === cell.row
      && last.cell.col + last.cell.colSpan === cell.col && !label && !last.slot.options.includes(options[0].label)) {
      last.slot._options.push(options[0]);
      last.slot.options.push(options[0].label);
      last.slot.hint = last.slot.options.join(' / ');
      this.lastSingle = { ...last, cell };
      return;
    }
    const clean = (d) => d.filter((x) => x && !/[□☐▢◻■☑▣◼]/.test(x));
    let display = clean(label ? [label] : []);
    let group = null;
    if (!display.length) {
      const cell = cellContext(path);
      if (cell) ({ display, group } = { display: clean(cell.display), group: cell.group });
    }
    const logs = new Map(options.map((o) => [o, o.paragraph._editLog?.length ?? 0]));
    const doc = this.doc;
    const collector = this;
    this.slots.push({
      id: `p${pIndex}.c${this.count++}`,
      kind: 'choice',
      labels: display.map(normaliseLabel).filter(Boolean),
      display,
      index: 1,
      group,
      key: '',
      value: options.filter((o) => o.checked).map((o) => o.label).join(', '),
      hint: options.map((o) => o.label).join(' / '),
      options: options.map((o) => o.label),
      _options: options,
      _fill(value) {
        for (const o of chooseOptions(options, value)) {
          if (o.checked) continue;
          const log = (o.paragraph._editLog ?? []).slice(logs.get(o));
          if (o.kind === 'form') {
            o.control.setChecked(true);
          } else if (o.kind === 'char') {
            const pos = mapPos(o.pos, log);
            o.paragraph.replaceRange(pos, pos + 1, FILLED[o.box], { lineSegs: 'keep' });
            recordEdit(o.paragraph, pos, pos + 1, 1);
          } else {
            const start = mapPos(o.start, log);
            const end = mapPos(o.end, log);
            const text = markText(doc, o.paragraph, start, end, collector.markChar());
            o.paragraph.replaceRange(start, end, text, { lineSegs: 'drop' });
            recordEdit(o.paragraph, start, end, text.length);
          }
          o.checked = true;
        }
      },
    });
    if (options.length === 1 && cell) this.lastSingle = { table: step.control, cell, slot: this.slots[this.slots.length - 1] };
  }
}

/** The mark for a bracket box, padded with spaces to the width of the spacing it replaces. */
function markText(doc, paragraph, start, end, mark) {
  const styleAt = (pos) => (doc.charStyleAt ? doc.charStyleAt(paragraph, pos) : null);
  const style = styleAt(start);
  let inner = 0;
  for (let p = start; p < end; p++) inner += absWidth(' ', styleAt(p));
  const sp = advance(' ', style) * sizeOf(style);
  const pad = Math.max(0, Math.round((inner - absWidth(mark, style)) / sp));
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + mark + ' '.repeat(pad - left);
}
