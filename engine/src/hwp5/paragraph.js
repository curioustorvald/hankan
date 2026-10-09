// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Paragraphs of HWP 5.0 body text and the one edit the filler makes to
// them: replacing a range of plain text.
//
// Sources:
//   paragraph header .......... hwp5 §4.3.1 표 58 p.33–34
//   paragraph text ............ hwp5 §4.3.2 표 60 p.34; the paragraph-end
//                               character 13 and the text length counting it:
//                               hwp5 §3.2.3 p.10 and §4.3.1 p.34
//   control characters ........ hwp5 §3.2.3 표 6 p.10–11 (codes, kinds, sizes)
//   char shape runs ........... hwp5 §4.3.3 표 61 p.34 and 그림 47 (first
//                               position must be 0)
//   line segments ............. hwp5 §4.3.4 표 62 p.35 (a layout cache)
//   range tags ................ hwp5 §4.3.5 표 63 p.35

import { FormatError, viewOf, Writer } from '../util/bytes.js';
import { Record } from './records.js';
import { TAG } from './tags.js';

export const PARA_END = 13;
export const LINE_BREAK = 10;
export const TAB = 9;
export const FIELD_BEGIN = 3;
export const FIELD_END = 4;

/** Kind of each control character 0–31 (hwp5 표 6). */
const CONTROL_KIND = (() => {
  const k = new Array(32).fill('char');
  for (const c of [1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]) k[c] = 'extended';
  for (const c of [4, 5, 6, 7, 8, 9, 19, 20]) k[c] = 'inline';
  return k;
})();

export function controlKind(code) {
  return code < 32 ? CONTROL_KIND[code] : null;
}

/**
 * Visible stand-ins for char-sized control characters; one character each,
 * so that a text unit's text has exactly one character per position.
 * Codes 0 and 25–29 are "unusable" or reserved (hwp5 표 6).
 */
const CHAR_CONTROL_TEXT = { 10: '\n', 24: '-', 30: '\u00a0', 31: ' ' };
const RESERVED_TEXT = '\ufffd';

const NCHARS_MASK = 0x7fffffff;
const LAST_IN_LIST = 0x80000000;

export class Paragraph {
  /**
   * @param {import('./section.js').Section} section
   * @param {Record} header HWPTAG_PARA_HEADER
   */
  constructor(section, header) {
    this.section = section;
    this.header = header;
    this.level = header.level;
    /** @type {Record|null} */ this.textRec = null;
    /** @type {Record|null} */ this.charShapeRec = null;
    /** @type {Record|null} */ this.lineSegRec = null;
    /** @type {Record|null} */ this.rangeTagRec = null;
    /** Controls anchored in this paragraph, in order (one per extended control char). */
    this.controls = [];
    this._units = null;
  }

  // ---- header fields (hwp5 표 58) -----------------------------------------

  #hv() { return viewOf(this.header.data); }
  get nChars() { return this.#hv().getUint32(0, true) & NCHARS_MASK; }
  get controlMask() { return this.#hv().getUint32(4, true); }
  get paraShapeId() { return this.#hv().getUint16(8, true); }
  get styleId() { return this.header.data[10]; }
  get charShapeCount() { return this.#hv().getUint16(12, true); }
  get rangeTagCount() { return this.#hv().getUint16(14, true); }
  /** Whether text can be added: there is a character shape for it to take (hwp5 표 61). */
  get canHoldText() { return this.charShapeCount > 0; }
  get lineSegCount() { return this.#hv().getUint16(16, true); }

  // ---- text ----------------------------------------------------------------

  /** UTF-16 code units of the paragraph, including control characters and the final 13. */
  codeUnits() {
    if (this.textRec) {
      const d = this.textRec.data;
      const v = viewOf(d);
      const out = new Uint16Array(d.length >> 1);
      for (let i = 0; i < out.length; i++) out[i] = v.getUint16(2 * i, true);
      return out;
    }
    // "텍스트의 수가 1 이상이면 문자 수만큼 텍스트를 로드하고 그렇지 않을 경우
    // PARA_BREAK로 문단을 생성한다" (hwp5 p.34): no text record means just the
    // paragraph end.
    return Uint16Array.of(PARA_END);
  }

  /**
   * The paragraph as a list of units:
   *   { type: 'text', pos, end, text }           ordinary characters and char-sized controls
   *   { type: 'control', pos, end, code, kind }  inline or extended control (8 code units)
   *   { type: 'end', pos, end }                  paragraph end (13)
   * Extended controls carry `control`, the matching entry of `controls`.
   */
  units() {
    if (this._units) return this._units;
    const cu = this.codeUnits();
    const units = [];
    let ext = 0;
    let run = null;
    const flush = () => { if (run) { units.push(run); run = null; } };
    for (let i = 0; i < cu.length;) {
      const c = cu[i];
      const kind = controlKind(c);
      if (c === PARA_END) {
        flush();
        units.push({ type: 'end', pos: i, end: i + 1 });
        i += 1;
      } else if (kind === null || kind === 'char') {
        const t = kind === null ? String.fromCharCode(c) : (CHAR_CONTROL_TEXT[c] ?? RESERVED_TEXT);
        if (!run) run = { type: 'text', pos: i, end: i, text: '' };
        run.text += t;
        run.end = i + 1;
        i += 1;
      } else {
        flush();
        if (i + 8 > cu.length) throw new FormatError(`paragraph: control ${c} truncated at ${i}`);
        const u = { type: 'control', pos: i, end: i + 8, code: c, kind };
        if (kind === 'extended') u.control = this.controls[ext++] ?? null;
        units.push(u);
        i += 8;
      }
    }
    flush();
    this._units = units;
    return units;
  }

  /** Visible text: ordinary characters, line breaks as '\n', tabs as '\t'; other controls omitted. */
  get text() {
    let s = '';
    for (const u of this.units()) {
      if (u.type === 'text') s += u.text;
      else if (u.type === 'control' && u.code === TAB) s += '\t';
    }
    return s;
  }

  /** Id of the character shape in effect at `pos` (hwp5 표 61). */
  charShapeIdAt(pos) {
    let id = null;
    for (const s of this.charShapes()) { if (s.pos > pos) break; id = s.id; }
    return id;
  }

  /** Character shape runs: [{ pos, id }] (hwp5 표 61). */
  charShapes() {
    return readPairs(this.charShapeRec, 8, (v, o) => ({ pos: v.getUint32(o, true), id: v.getUint32(o + 4, true) }));
  }

  /** Line segments (hwp5 표 62): raw 36-byte entries with their text start. */
  lineSegs() {
    return readPairs(this.lineSegRec, 36, (v, o, d) => ({ pos: v.getUint32(o, true), raw: d.subarray(o, o + 36) }));
  }

  /** Range tags (hwp5 표 63). */
  rangeTags() {
    return readPairs(this.rangeTagRec, 12, (v, o) => ({ start: v.getUint32(o, true), end: v.getUint32(o + 4, true), tag: v.getUint32(o + 8, true) }));
  }

  // ---- editing -------------------------------------------------------------

  /**
   * Replace the code units [start, end) with `text`. The range may contain
   * ordinary characters, char-sized controls and tabs, but no other
   * control. Character shapes, range tags and line segment positions are
   * moved to keep their meaning. The new text takes the character shape in
   * effect at `start`, or, with `styleOf`, the one in effect at that position
   * (a filled click-here field takes the shape of the field itself rather
   * than that of its guide text; PROVENANCE.md, C9).
   *
   * Line segments are a layout cache (hwp5 §4.3.4). By default ('drop') the
   * edited paragraph's cache is removed, as it is in some paragraphs of the
   * corpus: renders show that older documents are otherwise drawn from the
   * stale cache (PROVENANCE.md, R1). 'keep' keeps the cache and only moves
   * its text positions.
   */
  replaceRange(start, end, text, { lineSegs = 'drop', styleOf = null } = {}) {
    const cu = this.codeUnits();
    const last = cu.length - 1;
    if (!(0 <= start && start <= end && end <= last) || cu[last] !== PARA_END) {
      throw new RangeError(`paragraph: bad range [${start}, ${end}) in ${cu.length} code units`);
    }
    if (splitsPair(cu, start) || splitsPair(cu, end)) throw new RangeError('paragraph: range splits a surrogate pair');
    for (const u of this.units()) {
      if (u.end <= start || u.pos >= end) continue;
      if (u.type === 'control' && u.code === TAB && u.pos >= start && u.end <= end) continue;
      if (u.type !== 'text') throw new RangeError(`paragraph: range [${start}, ${end}) contains a control (code ${u.code})`);
    }
    const ins = encodeText(text);
    const k = ins.length;
    const delta = k - (end - start);
    const map = (p) => (p <= start ? p : p >= end ? p + delta : start + k);

    const next = new Uint16Array(cu.length + delta);
    next.set(cu.subarray(0, start), 0);
    next.set(ins, start);
    next.set(cu.subarray(end), start + k);

    this.#writeText(next);
    const shapeAt = (p) => this.charShapes().filter((s) => s.pos <= p).pop()?.id;
    const style = styleOf !== null && k > 0 ? { start, k, id: shapeAt(styleOf), after: shapeAt(end) } : null;
    this.#writeCharShapes(map, style);
    this.#writeRangeTags(map);
    this.#writeLineSegs(map, lineSegs);
    this.#writeHeader(next);
    this._units = null;
  }

  /**
   * Give the text in [start, end) the character shapes `mapId(id)` in place
   * of their shapes `id` (hwp5 표 61); the text itself does not change. The
   * paragraph loses its line segments (PROVENANCE.md R1) unless `lineSegs`
   * is 'keep', for a change that cannot move text (a colour).
   * @returns {boolean} whether anything changed
   */
  restyle(start, end, mapId, { lineSegs = 'drop' } = {}) {
    const shapes = this.charShapes();
    if (!this.charShapeRec || !shapes.length || start >= end) return false;
    const last = this.codeUnits().length - 1; // the paragraph end
    if (end > last) throw new RangeError(`paragraph: bad range [${start}, ${end})`);
    const idAt = (p) => { let id = shapes[0].id; for (const s of shapes) { if (s.pos > p) break; id = s.id; } return id; };
    let out = shapes.filter((s) => s.pos < start);
    out.push({ pos: start, id: mapId(idAt(start)) });
    for (const s of shapes) if (s.pos > start && s.pos < end) out.push({ pos: s.pos, id: mapId(s.id) });
    out.push({ pos: end, id: idAt(end) });
    out.push(...shapes.filter((s) => s.pos > end));
    // No run may repeat the shape of the run before it at the two boundaries.
    out = out.filter((s, i) => !(i > 0 && (s.pos === start || s.pos === end) && s.id === out[i - 1].id));
    if (out.length === shapes.length && out.every((s, i) => s.pos === shapes[i].pos && s.id === shapes[i].id)) return false;
    const w = new Writer(out.length * 8);
    for (const { pos, id } of out) w.u32(pos).u32(id);
    this.charShapeRec.setData(w.finish());
    if (lineSegs === 'drop') this.#writeLineSegs((p) => p, 'drop');
    this.#writeHeader(this.codeUnits());
    return true;
  }

  /** Ids of the character shapes used by [start, end). */
  charShapeIdsIn(start, end) {
    const shapes = this.charShapes();
    return new Set(shapes.filter((s, i) => s.pos < end && (shapes[i + 1]?.pos ?? Infinity) > start).map((s) => s.id));
  }

  #writeText(cu) {
    if (cu.length === 1) {
      // Only the paragraph end is left: no text record, as in the files the spec
      // describes (hwp5 p.34) and in every such paragraph of the corpus.
      if (this.textRec) { this.section.removeRecord(this.textRec); this.textRec = null; }
      return;
    }
    const data = new Uint8Array(cu.length * 2);
    const v = viewOf(data);
    for (let i = 0; i < cu.length; i++) v.setUint16(2 * i, cu[i], true);
    if (this.textRec) {
      this.textRec.setData(data);
    } else {
      this.textRec = new Record(TAG.PARA_TEXT, this.level + 1, data);
      this.section.insertAfter(this.header, this.textRec);
    }
  }

  #writeCharShapes(map, style) {
    if (!this.charShapeRec) return;
    let out = [];
    for (const { pos, id } of this.charShapes()) {
      const p = map(pos);
      if (out.length && out[out.length - 1].pos === p) out[out.length - 1].id = id;
      else out.push({ pos: p, id });
    }
    if (style && style.id !== undefined) {
      // The new text [start, start + k) in shape `style.id`, followed by the
      // shape that the text after the range had.
      const end = style.start + style.k;
      const hadEnd = out.some((s) => s.pos === end);
      out = out.filter((s) => s.pos < style.start || s.pos >= end);
      out.push({ pos: style.start, id: style.id });
      if (!hadEnd) out.push({ pos: end, id: style.after });
      out.sort((a, b) => a.pos - b.pos);
      // No run may repeat the shape of the run before it at the two new boundaries.
      out = out.filter((s, i) => !(i > 0 && (s.pos === style.start || s.pos === end) && s.id === out[i - 1].id));
    }
    if (out.length && out[0].pos !== 0) out[0].pos = 0;
    const w = new Writer(out.length * 8);
    for (const { pos, id } of out) w.u32(pos).u32(id);
    this.charShapeRec.setData(w.finish());
  }

  #writeRangeTags(map) {
    if (!this.rangeTagRec) return;
    const w = new Writer();
    for (const { start, end, tag } of this.rangeTags()) {
      const s = map(start), e = map(end);
      if (e < s) continue;
      w.u32(s).u32(e).u32(tag);
    }
    this.rangeTagRec.setData(w.finish());
  }

  #writeLineSegs(map, policy) {
    if (!this.lineSegRec) return;
    if (policy === 'drop') {
      this.section.removeRecord(this.lineSegRec);
      this.lineSegRec = null;
      return;
    }
    // `map` never reverses order, so the segments stay in order; none is
    // dropped, since a line may legitimately have several segments at one
    // position (hwp5 표 62, tag bits 17–18).
    const w = new Writer();
    for (const { pos, raw } of this.lineSegs()) {
      const entry = raw.slice();
      viewOf(entry).setUint32(0, map(pos), true);
      w.put(entry);
    }
    this.lineSegRec.setData(w.finish());
  }

  #writeHeader(cu) {
    const data = this.header.data.slice();
    const v = viewOf(data);
    const flag = v.getUint32(0, true) & LAST_IN_LIST;
    v.setUint32(0, (flag | cu.length) >>> 0, true);
    v.setUint32(4, controlMaskOf(cu), true);
    if (this.charShapeRec) v.setUint16(12, this.charShapeRec.data.length / 8, true);
    if (this.rangeTagRec) v.setUint16(14, this.rangeTagRec.data.length / 12, true);
    v.setUint16(16, this.lineSegRec ? this.lineSegRec.data.length / 36 : 0, true);
    this.header.setData(data);
  }
}

/** True when position `p` falls between the two halves of a surrogate pair. */
export function splitsPair(cu, p) {
  return p > 0 && p < cu.length && (cu[p - 1] & 0xfc00) === 0xd800 && (cu[p] & 0xfc00) === 0xdc00;
}

function readPairs(rec, size, fn) {
  if (!rec) return [];
  const d = rec.data;
  const v = viewOf(d);
  const out = [];
  for (let o = 0; o + size <= d.length; o += size) out.push(fn(v, o, d));
  return out;
}

/**
 * The control mask of a paragraph: bit n set when control character n
 * occurs ("(UINT32)(1<<ctrlch) 조합", hwp5 표 58). The paragraph end is not
 * counted; corpus check C3 confirms this rule for every paragraph.
 */
export function controlMaskOf(cu) {
  let mask = 0;
  for (let i = 0; i < cu.length;) {
    const c = cu[i];
    const kind = controlKind(c);
    if (kind && c !== PARA_END) mask |= 1 << c;
    i += kind === 'inline' || kind === 'extended' ? 8 : 1;
  }
  return mask >>> 0;
}

/**
 * Plain text to code units: '\n' becomes a line break (10, char-sized);
 * a tab becomes a space, since a tab control carries layout data the
 * filler cannot know; other control characters are dropped.
 */
export function encodeText(text) {
  const out = [];
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    for (let i = 0; i < ch.length; i++) {
      const c = ch.charCodeAt(i);
      if (c === 10) out.push(LINE_BREAK);
      else if (c === 9) out.push(32);
      else if (c >= 32) out.push(c);
    }
  }
  return Uint16Array.from(out);
}
