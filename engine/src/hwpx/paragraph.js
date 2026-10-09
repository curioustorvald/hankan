// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Paragraphs of OWPML (.hwpx) section XML and the filler's one edit:
// replacing a range of plain text.
//
// Sources (owpml-ksx6101):
//   <p> holds <run>s; a run holds controls (<ctrl>, <secPr>, objects) and
//   text (<t>) ........................................... §10.4, §10.5
//   <t> content: characters plus <tab>, <lineBreak>, <hyphen>, <nbSpace>,
//   <fwSpace>, <titleMark>, highlight and change-tracking marks .. §10.8
//   <ctrl> children (fieldBegin, fieldEnd, colPr, ...) .... §10.7
//
// Text positions follow the HWP 5.0 convention (hwp5 표 6): an ordinary
// character counts 1, a control 8 (tab, title mark, and every control or
// object). Corpus observation C7 (PROVENANCE.md): the `textpos` of the
// <lineseg> elements that every corpus paragraph carries (they are not in
// the standard's schema) is counted this way.

import { escapeText } from './xml.js';
import { PARA_END, TAB, LINE_BREAK, FIELD_BEGIN, FIELD_END } from '../hwp5/paragraph.js';

const OBJECT = 11;
/** Code of the equivalent HWP 5.0 control character, for elements that count 8. */
const CONTROL_CODE = {
  secPr: 2, colPr: 2, fieldBegin: FIELD_BEGIN, fieldEnd: FIELD_END, bookmark: 22, indexmark: 22,
  header: 16, footer: 16, footNote: 17, endNote: 17, autoNum: 18, newNum: 18,
  pageNumCtrl: 21, pageHiding: 21, pageNum: 21, hiddenComment: 15, compose: 23, dutmal: 23,
};
const INLINE_CODES = new Set([FIELD_END, TAB, 8]);
/** Characters standing for empty elements inside <t>. */
const T_CHAR = { lineBreak: '\n', hyphen: '-', nbSpace: '\u00a0', fwSpace: ' ' };

export class HwpxParagraph {
  /**
   * @param {import('./section.js').HwpxSection} section
   * @param {import('./xml.js').XmlElement} el the <p> element
   */
  constructor(section, el) {
    this.section = section;
    this.el = el;
    /** Controls (objects wrapping elements), set by the section. */
    this.controls = [];
    this._units = null;
  }

  get xml() { return this.section.xml; }

  /**
   * Units in HWP 5.0 positions (see hwp5/paragraph.js units()):
   *   text    { pos, end, text, node: XmlText|XmlElement, offset, t, run }
   *   control { pos, end, code, kind, el, run, control? }
   *   end     { pos, end }
   * A text unit covers one UTF-16 code unit of one text node (or one
   * character element); adjacent text units are not merged.
   */
  units() {
    if (this._units) return this._units;
    const units = [];
    let pos = 0;
    const ctrlOf = new Map(this.controls.map((c) => [c.el, c]));
    const control = (el, run, code) => {
      const kind = INLINE_CODES.has(code) ? 'inline' : 'extended';
      const u = { type: 'control', pos, end: pos + 8, code, kind, el, run };
      if (ctrlOf.has(el)) u.control = ctrlOf.get(el);
      units.push(u);
      pos += 8;
    };
    for (const run of this.el.children) {
      if (run.type !== 'element' || run.local !== 'run') continue;
      for (const c of run.children) {
        if (c.type !== 'element') continue;
        if (c.local === 't') {
          for (const n of c.children) {
            if (n.type === 'text') {
              const v = n.value;
              for (let i = 0; i < v.length; i++) units.push({ type: 'text', pos, end: ++pos, text: v[i], node: n, offset: i, t: c, run });
            } else if (n.local in T_CHAR) {
              units.push({ type: 'text', pos, end: ++pos, text: T_CHAR[n.local], node: n, offset: 0, t: c, run });
            } else if (n.local === 'tab') {
              control(n, run, TAB);
            } else if (n.local === 'titleMark') {
              control(n, run, 8);
            }
            // Highlight and change-tracking marks take no position.
          }
        } else if (c.local === 'ctrl') {
          for (const k of c.children) if (k.type === 'element') control(k, run, CONTROL_CODE[k.local] ?? OBJECT);
        } else {
          control(c, run, CONTROL_CODE[c.local] ?? OBJECT);
        }
      }
    }
    units.push({ type: 'end', pos, end: pos + 1 });
    this._units = units;
    return units;
  }

  get paraShapeId() { return Number(this.el.attr('paraPrIDRef') ?? 0); }

  /** Whether text can be added at the end: there is a run whose character properties it can take. */
  get canHoldText() { return this.el.children.some((c) => c.type === 'element' && c.local === 'run'); }

  /** Id of the character properties (charPrIDRef of the run) in effect at `pos`. */
  charShapeIdAt(pos) {
    let run = null;
    for (const u of this.units()) {
      if (u.type === 'end') break;
      if (u.pos > pos) break;
      run = u.run;
    }
    run ??= this.el.all('run')[0] ?? null;
    return run ? Number(run.attr('charPrIDRef') ?? 0) : null;
  }

  /**
   * Give the text in [start, end) the character properties `mapId(id)` in
   * place of `id`: runs are split at `start` and `end` where they go on
   * past them, and the runs in between get the new charPrIDRef. The text
   * and every other element keep their nodes. The paragraph's layout cache
   * is dropped, as for an edit, unless `lineSegs` is 'keep' (for a change
   * that cannot move text, such as a colour).
   * @returns {boolean} whether anything changed
   */
  restyle(start, end, mapId, { lineSegs = 'drop' } = {}) {
    if (start >= end) return false;
    const inside = this.units().filter((u) => u.pos >= start && u.end <= end && u.type !== 'end');
    if (!inside.length || inside[0].pos !== start || inside[inside.length - 1].end !== end) throw new RangeError(`paragraph: bad range [${start}, ${end})`);
    const changes = new Map();
    for (const run of new Set(inside.map((u) => u.run))) {
      const old = Number(run.attr('charPrIDRef') ?? 0);
      if (mapId(old) !== old) changes.set(run, old);
    }
    if (!changes.size) return false;
    for (const run of changes.keys()) if (run.attr('charPrIDRef') === undefined) throw new RangeError('paragraph: run without charPrIDRef');
    this.#splitRunAt(start);
    this.#splitRunAt(end);
    for (const run of new Set(this.units().filter((u) => u.pos >= start && u.end <= end && u.type !== 'end').map((u) => u.run))) {
      const old = Number(run.attr('charPrIDRef'));
      const id = mapId(old);
      if (id !== old) this.xml.setAttr(run, 'charPrIDRef', String(id));
    }
    if (lineSegs === 'drop') this.#dropLineSegs();
    this._units = null;
    return true;
  }

  /** Ids of the character properties used by [start, end). */
  charShapeIdsIn(start, end) {
    const runs = this.units().filter((u) => u.type !== 'end' && u.end > start && u.pos < end).map((u) => u.run);
    return new Set(runs.map((r) => Number(r.attr('charPrIDRef') ?? 0)));
  }

  /** Make a run boundary at `pos`, if the units on both sides share a run. */
  #splitRunAt(pos) {
    let units = this.units();
    let u = units.find((x) => x.pos === pos);
    const prev = units.find((x) => x.end === pos);
    if (!u || u.type === 'end' || !prev || prev.run !== u.run) return;
    // A <t> that has text before `pos` is split in two first.
    const tOf = (x) => x.t ?? (x.el?.parent?.local === 't' ? x.el.parent : null);
    const t = tOf(u);
    if (t && tOf(prev) === t) {
      this.#splitT(t, units, pos);
      this._units = null;
      units = this.units();
      u = units.find((x) => x.pos === pos);
    }
    let holder = u.t ?? u.el;
    while (holder.parent !== u.run) holder = holder.parent;
    const index = u.run.children.indexOf(holder);
    this.xml.splitElement(u.run, index, this.xml.openTag(u.run));
    this._units = null;
  }

  /** Replace <t> by two <t>s, the second starting at `pos`. */
  #splitT(t, units, pos) {
    const mine = units.filter((x) => x.t === t || (x.type === 'control' && x.el.parent === t));
    const parts = ['', ''];
    let i = 0;
    for (const n of t.children) {
      if (n.type === 'text') {
        const v = n.value;
        let a = '';
        let b = '';
        for (let j = 0; j < v.length; j++, i++) { if (mine[i].pos < pos) a += v[j]; else b += v[j]; }
        parts[0] += escapeText(a);
        parts[1] += escapeText(b);
      } else if (n.local in T_CHAR || n.local === 'tab' || n.local === 'titleMark') {
        parts[mine[i++].pos < pos ? 0 : 1] += this.xml.text(n);
      } else {
        // Marks that take no position stay with the text before them.
        parts[i < mine.length && mine[i].pos >= pos ? 1 : 0] += this.xml.text(n);
      }
    }
    const open = this.xml.openTag(t);
    this.xml.replaceNode(t, parts.map((x) => `${open}${x}</${t.name}>`).join(''));
  }

  /** Visible text: characters, line breaks as '\n', tabs as '\t'. */
  get text() {
    let s = '';
    for (const u of this.units()) {
      if (u.type === 'text') s += u.text;
      else if (u.type === 'control' && u.code === TAB) s += '\t';
    }
    return s;
  }

  /** Total length in HWP 5.0 positions, including the paragraph end. */
  get length() {
    const u = this.units();
    return u[u.length - 1].end;
  }

  lineSegs() {
    const arr = this.el.first('linesegarray');
    return arr ? arr.all('lineseg') : [];
  }

  // ---- editing -------------------------------------------------------------

  /**
   * Replace positions [start, end) with `text`; same contract as the HWP 5.0
   * paragraph's replaceRange. The new text goes where the unit at `start`
   * is: into that unit's <t> when it is text, otherwise into a new <t> in
   * that unit's run, just before it, so it takes the character properties
   * that are in effect at `start`.
   */
  replaceRange(start, end, text, { lineSegs = 'drop', styleOf = null } = {}) {
    const units = this.units();
    const total = units[units.length - 1].pos;
    if (!(0 <= start && start <= end && end <= total)) throw new RangeError(`paragraph: bad range [${start}, ${end}) of ${total}`);
    const at = units.find((u) => u.pos >= start);
    if (!at || at.pos !== start) throw new RangeError(`paragraph: ${start} is inside a control`);
    const half = (u) => (u?.type === 'text' ? u.text.charCodeAt(0) & 0xfc00 : 0);
    const splits = (p) => half(units.find((u) => u.end === p)) === 0xd800 && half(units.find((u) => u.pos === p)) === 0xdc00;
    if (splits(start) || splits(end)) throw new RangeError('paragraph: range splits a surrogate pair');
    const removed = units.filter((u) => u.pos >= start && u.end <= end && u.type !== 'end');
    if (removed.length && removed[removed.length - 1].end !== end) throw new RangeError(`paragraph: ${end} is inside a control`);
    for (const u of removed) {
      if (u.type === 'control' && u.code !== TAB) throw new RangeError(`paragraph: range [${start}, ${end}) contains a control`);
    }
    const insert = normalise(text);
    const k = hwpLength(insert);
    const delta = k - (end - start);
    const map = (p) => (p <= start ? p : p >= end ? p + delta : start + k);
    const prefix = this.el.prefix ? this.el.prefix + ':' : '';

    // Every <t> that loses content or receives the new text is rewritten.
    const inT = at.type === 'text' || (at.type === 'control' && at.el.parent?.local === 't');
    let target = inT ? (at.t ?? at.el.parent) : null;
    let point = !target && insert ? this.#insertionPoint(at) : null;
    // `styleOf`: the new text goes in the run of the control at that position
    // (a click-here field's own run rather than its guide text's), right after it.
    const styleUnit = styleOf === null ? null : units.find((u) => u.pos === styleOf && u.type === 'control');
    if (styleUnit && insert && (target ? target.parent : point.run) !== styleUnit.run) {
      let holder = styleUnit.el;
      while (holder.parent !== styleUnit.run) holder = holder.parent;
      const siblings = styleUnit.run.children;
      target = null;
      point = { run: styleUnit.run, before: siblings[siblings.indexOf(holder) + 1] ?? null };
    }
    // Every <t> that loses content or receives the new text is rewritten.
    const touched = new Set(removed.map((u) => u.t ?? u.el.parent));
    if (target) touched.add(target);
    for (const t of touched) {
      this.#rewriteT(t, units, start, end, t === target ? insert : null, prefix);
    }
    if (point) this.#insertT(point, insert, prefix);
    if (lineSegs === 'drop') this.#dropLineSegs();
    else this.#mapLineSegs(map);
    this._units = null;
  }

  #rewriteT(t, units, start, end, insert, prefix) {
    let inner = '';
    let inserted = false;
    const put = () => { if (insert !== null && !inserted) { inner += tContent(insert, prefix); inserted = true; } };
    const mine = units.filter((u) => (u.t === t) || (u.type === 'control' && u.el.parent === t));
    let i = 0;
    for (const n of t.children) {
      if (n.type === 'text') {
        const v = n.value;
        let kept = '';
        for (let j = 0; j < v.length; j++, i++) {
          const u = mine[i];
          if (u.pos === start) { inner += escapeText(kept); kept = ''; put(); }
          if (u.pos < start || u.pos >= end) kept += v[j];
        }
        inner += escapeText(kept);
      } else if (n.local in T_CHAR || n.local === 'tab' || n.local === 'titleMark') {
        const u = mine[i++];
        if (u.pos === start) put();
        if (u.pos < start || u.pos >= end) inner += this.xml.text(n);
      } else {
        inner += this.xml.text(n);
      }
    }
    put(); // insertion at the end of this <t>
    const xml = inner ? `${this.xml.openTag(t)}${inner}</${t.name}>` : `${this.xml.openTag(t).slice(0, -1)}/>`;
    this.xml.replaceNode(t, xml);
  }

  /**
   * Where a new <t> goes for an insertion before unit `at` (a control, or
   * the paragraph end): the run, and the child it goes before (null: at the
   * end of the run). Worked out before anything is changed, so that a
   * refused edit leaves the paragraph as it was.
   */
  #insertionPoint(at) {
    if (at.type === 'end') {
      const run = [...this.el.children].reverse().find((c) => c.type === 'element' && c.local === 'run');
      if (!run) throw new RangeError('paragraph has no run to hold text');
      return { run, before: null };
    }
    const run = at.run;
    // The element holding the control directly inside the run.
    let holder = at.el;
    while (holder.parent !== run) holder = holder.parent;
    if (holder.local === 'ctrl') {
      const first = holder.children.find((c) => c.type === 'element');
      if (first !== at.el) throw new RangeError('paragraph: insertion between two controls of one <ctrl>');
    }
    return { run, before: holder };
  }

  #insertT({ run, before }, insert, prefix) {
    const tag = `${prefix}t`;
    const xml = `<${tag}>${tContent(insert, prefix)}</${tag}>`;
    if (run.selfClosing) {
      this.xml.replaceNode(run, `${this.xml.openTag(run)}${xml}</${run.name}>`);
    } else {
      this.xml.insertChildren(run, before ? run.children.indexOf(before) : run.children.length, xml);
    }
  }

  /** Remove the paragraph's layout cache (<linesegarray>), as for HWP 5.0. */
  #dropLineSegs() {
    const arr = this.el.first('linesegarray');
    if (arr) this.xml.replaceNode(arr, '');
  }

  /** Move segment positions; as for HWP 5.0, segments are kept and stay in order. */
  #mapLineSegs(map) {
    for (const seg of this.lineSegs()) {
      const old = Number(seg.attr('textpos'));
      if (!Number.isFinite(old)) continue;
      const p = map(old);
      if (p !== old) this.xml.setAttr(seg, 'textpos', String(p));
    }
  }
}

/** Newlines unified, tabs as spaces (as for HWP 5.0), other control characters dropped. */
function normalise(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0009\u000b-\u001f]/g, '');
}

function hwpLength(s) {
  return s.length;
}

function tContent(s, prefix) {
  return s.split('\n').map(escapeText).join(`<${prefix}lineBreak/>`);
}

export { PARA_END, LINE_BREAK };
