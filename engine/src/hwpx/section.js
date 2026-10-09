// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// An OWPML section file (Contents/sectionN.xml) as paragraphs, controls
// and paragraph lists.
//
// Sources (owpml-ksx6101):
//   <sec> holds <p>s ...................................... §10.3
//   paragraph lists (<subList>) inside tables, text boxes,
//   headers, footnotes, captions .......................... §10.9.3.4.2, Annex E (ParaListType)
//   <tbl> rowCnt/colCnt, <tr>, <tc name>, <cellAddr>,
//   <cellSpan> ............................................ §10.9.3
//   <fieldBegin> (id, type, name, dirty, parameters) and
//   <fieldEnd beginIDRef> ................................. §10.7.3, §10.7.5
//   CLICK_HERE parameters (Direction, HelpState) .......... §10.7.3.2
//
// Elements are matched by local name. Corpus observation C8 (PROVENANCE.md):
// corpus documents use the namespace URIs http://www.hancom.co.kr/hwpml/2011/*
// rather than the http://www.owpml.org/owpml/2024/* URIs of the standard;
// the local names agree.

import { XmlDocument } from './xml.js';
import { HwpxParagraph } from './paragraph.js';

export class HwpxSection {
  /**
   * @param {string} path entry name, e.g. "Contents/section0.xml"
   * @param {string} src section XML text
   */
  constructor(path, src) {
    this.path = path;
    this.xml = new XmlDocument(src);
    const sec = this.xml.element;
    if (!sec || sec.local !== 'sec') throw new Error(`${path}: document element is not <sec>`);
    this.paragraphs = sec.all('p').map((p) => this.#paragraph(p));
  }

  #paragraph(el) {
    const p = new HwpxParagraph(this, el);
    for (const run of el.all('run')) {
      for (const c of run.children) {
        if (c.type !== 'element' || c.local === 't') continue;
        if (c.local === 'ctrl') {
          for (const k of c.children) if (k.type === 'element') p.controls.push(this.#control(k, p));
        } else {
          p.controls.push(this.#control(c, p));
        }
      }
    }
    return p;
  }

  #control(el, paragraph) {
    if (el.local === 'tbl') return new HwpxTable(el, paragraph, (list) => this.#list(list));
    if (el.local === 'fieldBegin') return new HwpxField(el, paragraph);
    if (el.local === 'fieldEnd') return new HwpxFieldEnd(el, paragraph);
    if (el.local === 'checkBtn' || el.local === 'radioBtn') return new HwpxFormButton(el, paragraph);
    const c = new HwpxControl(el, paragraph);
    c.lists = subLists(el).map((l) => this.#list(l));
    return c;
  }

  #list(subList) {
    return { el: subList, paragraphs: subList.all('p').map((p) => this.#paragraph(p)) };
  }

  get modified() {
    return this.xml.edits > 0;
  }

  serialize() {
    return this.xml.src;
  }

  *walk() {
    yield* walkParagraphs(this.paragraphs, []);
  }
}

function* walkParagraphs(paragraphs, path) {
  for (const p of paragraphs) {
    yield { paragraph: p, path };
    for (const c of p.controls) {
      for (const list of c.lists) yield* walkParagraphs(list.paragraphs, [...path, { control: c, list }]);
    }
  }
}

/** <subList> elements below `el` that are not inside a deeper paragraph. */
function subLists(el) {
  const out = [];
  const visit = (n) => {
    for (const c of n.children) {
      if (c.type !== 'element') continue;
      if (c.local === 'subList') out.push(c);
      else if (c.local !== 'p') visit(c);
    }
  };
  visit(el);
  return out;
}

export class HwpxControl {
  constructor(el, paragraph) {
    this.el = el;
    this.paragraph = paragraph;
    this.lists = [];
  }

  get idString() { return this.el.local; }
}

export class HwpxTable extends HwpxControl {
  constructor(el, paragraph, makeList) {
    super(el, paragraph);
    this.rows = Number(el.attr('rowCnt'));
    this.cols = Number(el.attr('colCnt'));
    const caption = el.first('caption');
    this.caption = caption?.first('subList') ? makeList(caption.first('subList')) : null;
    this.cells = [];
    for (const tr of el.all('tr')) {
      for (const tc of tr.all('tc')) {
        const sub = tc.first('subList');
        const list = sub ? makeList(sub) : { el: null, paragraphs: [] };
        this.cells.push(new HwpxCell(tc, list));
      }
    }
    this.lists = [...(this.caption ? [this.caption] : []), ...this.cells.map((c) => c.list)];
  }
}

export class HwpxCell {
  constructor(tc, list) {
    this.el = tc;
    this.list = list;
    const addr = tc.first('cellAddr');
    const span = tc.first('cellSpan');
    this.col = Number(addr?.attr('colAddr') ?? 0);
    this.row = Number(addr?.attr('rowAddr') ?? 0);
    this.colSpan = Number(span?.attr('colSpan') ?? 1);
    this.rowSpan = Number(span?.attr('rowSpan') ?? 1);
    const sz = tc.first('cellSz');
    this.width = Number(sz?.attr('width') ?? 0);
    this.height = Number(sz?.attr('height') ?? 0);
    /** "셀 필드 이름" (owpml §10.9.3.4.2). */
    this.name = tc.attr('name') || null;
  }

  get paragraphs() { return this.list.paragraphs; }
}

const FIELD_KIND = {
  CLICK_HERE: 'clickhere', HYPERLINK: 'hyperlink', BOOKMARK: 'bookmark', FORMULA: 'formula',
  DATE: 'date', DOC_DATE: 'docdate', SUMMARY: 'summary', USER_INFO: 'userinfo', PATH: 'path',
  CROSSREF: 'crossref', MAILMERGE: 'mailmerge', MEMO: 'memo',
};

export class HwpxField extends HwpxControl {
  constructor(el, paragraph) {
    super(el, paragraph);
    this.type = el.attr('type') ?? '';
    this.kind = FIELD_KIND[this.type] ?? 'other';
    this.name = el.attr('name') || null;
    this.fieldId = el.attr('id') ?? null;
    const params = el.first('parameters');
    const str = (n) => params?.all('stringParam').find((p) => p.attr('name') === n)?.children.map((c) => c.value ?? '').join('') ?? null;
    this.command = str('Command');
    this.direction = str('Direction');
  }

  get dirty() { return this.el.attr('dirty') === '1' || this.el.attr('dirty') === 'true'; }

  set dirty(on) {
    if (!this.el.attrs.has('dirty')) return;
    this.paragraph.section.xml.setAttr(this.el, 'dirty', on ? '1' : '0');
  }
}

/**
 * <checkBtn> and <radioBtn> (owpml-ksx6101 §10.11.5–10.11.6, AbstractButtonObjectType:
 * caption, value = UNCHECKED | CHECKED | INDETERMINATE).
 */
export class HwpxFormButton extends HwpxControl {
  get formType() { return this.el.local === 'checkBtn' ? 'check' : 'radio'; }
  get caption() { return (this.el.attr('caption') ?? '').trim(); }
  get checked() { return this.el.attr('value') === 'CHECKED'; }

  setChecked(on) {
    const value = on ? 'CHECKED' : 'UNCHECKED';
    if (this.el.attrs.has('value')) this.paragraph.section.xml.setAttr(this.el, 'value', value);
    else throw new RangeError('form button without a value attribute');
  }
}

export class HwpxFieldEnd extends HwpxControl {
  constructor(el, paragraph) {
    super(el, paragraph);
    this.beginId = el.attr('beginIDRef') ?? null;
  }
}
