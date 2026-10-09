// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// A BodyText/Section stream as paragraphs, controls and paragraph lists.
//
// Sources:
//   record levels form a hierarchy ............ hwp5 §4.1 p.16 ("Level")
//   section = list of paragraphs .............. hwp5 §3.2.3 표 5 p.9–10
//   paragraph children (text, char shapes,
//     line segments, range tags, controls) .... hwp5 표 5, §4.3.1–4.3.6
//   one control per extended control char ..... hwp5 §3.2.3 p.10–12, §4.3.6
//   lists: a LIST_HEADER, then its paragraphs . hwp5 §3.2.3 p.11 ("실제 문단들은
//                                               그 다음에 serialize된다"), §4.3.7 표 65
//   table record and cells .................... hwp5 §4.3.9.1 표 74–80 p.39–40
//   field controls ............................ hwp5 §4.3.10.15 표 152–153 p.61
//   field name in CTRL_DATA ................... hwp5 §4.3.8 표 66 p.36
//
// Corpus observations used here (PROVENANCE.md): C4, the paragraphs of a
// list are siblings of its LIST_HEADER (same level); C5, in a table cell's
// LIST_HEADER the cell properties of 표 80 start at byte 8.

import { FormatError, Reader, viewOf } from '../util/bytes.js';
import { parseRecords, serializeRecords } from './records.js';
import { TAG, CTRL, FIELD, ctrlIdString, isFieldCtrl } from './tags.js';
import { Paragraph } from './paragraph.js';
import { firstString } from './params.js';
import { FormObjectInfo } from './formobject.js';

export class Section {
  /**
   * @param {string} path stream path, e.g. "BodyText/Section0"
   * @param {Uint8Array} data decompressed stream
   */
  constructor(path, data) {
    this.path = path;
    this.records = parseRecords(data);
    this.dirty = false;
    const tree = buildTree(this.records);
    /** Top-level paragraphs. */
    this.paragraphs = [];
    for (const node of tree) {
      if (node.rec.tag === TAG.PARA_HEADER) this.paragraphs.push(this.#paragraph(node));
    }
  }

  #paragraph(node) {
    const p = new Paragraph(this, node.rec);
    for (const child of node.children) {
      const r = child.rec;
      switch (r.tag) {
        case TAG.PARA_TEXT: p.textRec = r; break;
        case TAG.PARA_CHAR_SHAPE: p.charShapeRec = r; break;
        case TAG.PARA_LINE_SEG: p.lineSegRec = r; break;
        case TAG.PARA_RANGE_TAG: p.rangeTagRec = r; break;
        case TAG.CTRL_HEADER: p.controls.push(this.#control(child, p)); break;
        default: break;
      }
    }
    return p;
  }

  #control(node, paragraph) {
    const id = viewOf(node.rec.data).getUint32(0, true);
    const lists = this.#lists(node.children);
    let control;
    const form = node.children.find((n) => n.rec.tag === TAG.FORM_OBJECT);
    if (id === CTRL.TABLE) control = new Table(node, paragraph, lists);
    else if (isFieldCtrl(id)) control = new Field(node, paragraph, lists);
    else if (form) control = new FormControl(node, paragraph, lists, form.rec);
    else control = new Control(node, paragraph, lists);
    return control;
  }

  /** Paragraph lists among a control's descendants. */
  #lists(children) {
    const lists = [];
    let current = null;
    children.forEach((child, index) => {
      const r = child.rec;
      if (r.tag === TAG.LIST_HEADER) {
        current = new ParagraphList(r, index);
        lists.push(current);
      } else if (r.tag === TAG.PARA_HEADER) {
        if (!current) { current = new ParagraphList(null, index); lists.push(current); }
        current.paragraphs.push(this.#paragraph(child));
      } else {
        current = null;
        // Lists can sit deeper, e.g. the text box of a drawing object.
        for (const nested of this.#lists(child.children)) {
          nested.index = index;
          lists.push(nested);
        }
      }
    });
    return lists;
  }

  // ---- record list edits (used by Paragraph) -------------------------------

  insertAfter(anchor, rec) {
    const i = this.records.indexOf(anchor);
    if (i < 0) throw new Error('section: anchor record not found');
    this.records.splice(i + 1, 0, rec);
    this.dirty = true;
  }

  removeRecord(rec) {
    const i = this.records.indexOf(rec);
    if (i < 0) throw new Error('section: record not found');
    this.records.splice(i, 1);
    this.dirty = true;
  }

  get modified() {
    return this.dirty || this.records.some((r) => r.modified);
  }

  serialize() {
    return serializeRecords(this.records);
  }

  /** Every paragraph, depth first, with the chain of containers above it. */
  *walk() {
    yield* walkParagraphs(this.paragraphs, []);
  }
}

function* walkParagraphs(paragraphs, path) {
  for (const p of paragraphs) {
    yield { paragraph: p, path };
    for (const c of p.controls) {
      for (const list of c.lists) {
        yield* walkParagraphs(list.paragraphs, [...path, { control: c, list }]);
      }
    }
  }
}

/** Group records into a tree by level (hwp5 §4.1). */
function buildTree(records) {
  const roots = [];
  const stack = [];
  for (const rec of records) {
    const node = { rec, children: [] };
    while (stack.length && stack[stack.length - 1].rec.level >= rec.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

export class ParagraphList {
  /**
   * @param {import('./records.js').Record|null} header HWPTAG_LIST_HEADER
   * @param {number} index position among the control's child records
   */
  constructor(header, index) {
    this.header = header;
    this.index = index;
    this.paragraphs = [];
  }

  /** Paragraph count from the list header (hwp5 표 65). */
  get declaredCount() {
    return this.header ? viewOf(this.header.data).getInt16(0, true) : null;
  }
}

export class Control {
  constructor(node, paragraph, lists) {
    this.header = node.rec;
    this.node = node;
    this.paragraph = paragraph;
    this.lists = lists;
    this.id = viewOf(node.rec.data).getUint32(0, true);
  }

  get idString() { return ctrlIdString(this.id); }

  childRecord(tag) {
    return this.node.children.find((n) => n.rec.tag === tag)?.rec ?? null;
  }
}

export class Table extends Control {
  constructor(node, paragraph, lists) {
    super(node, paragraph, lists);
    const at = node.children.findIndex((n) => n.rec.tag === TAG.TABLE);
    if (at < 0) throw new FormatError('table control without a TABLE record');
    // Table properties (hwp5 표 75): UINT32 attr, UINT16 rows, UINT16 cols, ...
    const r = new Reader(node.children[at].rec.data);
    this.attr = r.u32();
    this.rows = r.u16();
    this.cols = r.u16();
    // A caption list (hwp5 표 68, 표 71) comes before the table record, the
    // cell lists (표 74, 표 79) after it.
    this.caption = lists.find((l) => l.index < at) ?? null;
    this.cells = lists.filter((l) => l.index > at).map((list) => new Cell(list));
  }
}

const CELL_OFFSET = 8; // corpus observation C5

export class Cell {
  constructor(list) {
    this.list = list;
    const d = list.header?.data;
    if (!d || d.length < CELL_OFFSET + 26) throw new FormatError('table cell list header too short');
    // Cell properties (hwp5 표 80).
    const v = viewOf(d);
    this.col = v.getUint16(CELL_OFFSET, true);
    this.row = v.getUint16(CELL_OFFSET + 2, true);
    this.colSpan = v.getUint16(CELL_OFFSET + 4, true);
    this.rowSpan = v.getUint16(CELL_OFFSET + 6, true);
    this.width = v.getUint32(CELL_OFFSET + 8, true);
    this.height = v.getUint32(CELL_OFFSET + 12, true);
    this.borderFillId = v.getUint16(CELL_OFFSET + 24, true);
  }

  get paragraphs() { return this.list.paragraphs; }
}

/** A form object (hwp5 표 57 "양식 개체"); check boxes and radio buttons can be marked (C11). */
export class FormControl extends Control {
  constructor(node, paragraph, lists, rec) {
    super(node, paragraph, lists);
    try {
      this.form = new FormObjectInfo(rec);
    } catch {
      this.form = null; // a form object the filler does not know: left alone
    }
  }

  /** 'check' or 'radio', or null for other form objects. */
  get formType() { return this.form?.formType ?? null; }
  get caption() { return this.form?.caption ?? ''; }
  get checked() { return this.form?.checked ?? false; }
  setChecked(on) { this.form.setChecked(on); }
}

export class Field extends Control {
  constructor(node, paragraph, lists) {
    super(node, paragraph, lists);
    // Field (hwp5 표 152): ctrl id, UINT attr, BYTE etc, WORD len, WCHAR command[len], UINT32 id.
    const r = new Reader(node.rec.data);
    r.u32();
    this.attr = r.u32();
    this.etc = r.u8();
    this.command = r.utf16(r.u16());
    this.fieldId = r.remaining >= 4 ? r.u32() : null;
    const data = this.childRecord(TAG.CTRL_DATA);
    this.name = data ? firstString(data.data) || null : null;
    this.kind = FIELD_KIND.get(this.id) ?? 'other';
    this.direction = this.kind === 'clickhere' ? clickHereDirection(this.command) : null;
  }

  /** "필드 내용이 수정되었는지 여부" (hwp5 표 153, bit 15). */
  get dirty() { return !!(this.attr & 0x8000); }

  set dirty(on) {
    const attr = on ? this.attr | 0x8000 : this.attr & ~0x8000;
    if (attr === this.attr) return;
    const data = this.header.data.slice();
    viewOf(data).setUint32(4, attr >>> 0, true);
    this.header.setData(data);
    this.attr = attr >>> 0;
  }
}

const FIELD_KIND = new Map([
  [FIELD.CLICKHERE, 'clickhere'], [FIELD.HYPERLINK, 'hyperlink'], [FIELD.BOOKMARK, 'bookmark'],
  [FIELD.FORMULA, 'formula'], [FIELD.DATE, 'date'], [FIELD.DOCDATE, 'docdate'], [FIELD.SUMMARY, 'summary'],
  [FIELD.USERINFO, 'userinfo'], [FIELD.PATH, 'path'], [FIELD.CROSSREF, 'crossref'],
  [FIELD.MAILMERGE, 'mailmerge'], [FIELD.MEMO, 'memo'],
]);

/**
 * The guide text ("안내문", owpml-ksx6101 §10.7.3.2 Direction) of a click-here
 * field. The command string has the form shown in the sample of
 * owpml-ksx6101 §10.7.3.1: "Clickhere:set:N:Direction:wstring:M:<M chars> ...".
 * Some corpus documents use an older form, "<guide>;<help>;..." with "\;"
 * escaping a semicolon (PROVENANCE.md, C10); its first part is the guide.
 */
export function clickHereDirection(command) {
  const m = /Direction:wstring:(\d+):/.exec(command);
  if (m) {
    const start = m.index + m[0].length;
    return command.slice(start, start + Number(m[1]));
  }
  const first = /^((?:[^;\\]|\\.)*);/.exec(command);
  return first ? first[1].replace(/\\(.)/g, '$1') : null;
}
