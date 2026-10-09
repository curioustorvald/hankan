// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// The parts of DocInfo the filler reads: fonts, character shapes and
// paragraph alignment, to work out how wide text will be and what colour
// it is; and its one edit of DocInfo: adding a black copy of a character
// shape, for text written over coloured text.
//
// Sources:
//   DocInfo records and their order ......... hwp5 §3.2.2 표 4 p.9
//   ID mapping counts ........................ hwp5 §4.2.2 표 15–16 p.18
//   face names ............................... hwp5 §4.2.4 표 19 p.20
//   character shapes (faces, ratio, spacing,
//     relative size, base size, attributes,
//     text colour at byte 52) ................ hwp5 §4.2.6 표 33–35 p.24–25
//   COLORREF (0x00bbggrr) .................... hwp5 §2 표 1 p.6
//   paragraph shape attribute (alignment) .... hwp5 §4.2.10 표 43–44 p.28

import { Reader, viewOf } from '../util/bytes.js';
import { parseRecords, serializeRecords, Record } from './records.js';
import { DOCINFO } from './tags.js';

/** Languages of 표 34, in the order of the per-language arrays. */
export const LANGS = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];
/** Index of the character shape count in the ID mappings (표 16). */
const CHAR_SHAPE_COUNT = 9;
/** Byte offset of the text colour in a character shape (표 33). */
const TEXT_COLOUR = 52;
/** Alignment of 표 44 bits 2–4. */
const ALIGN = ['justify', 'left', 'right', 'center', 'distribute', 'divide'];

export class DocInfo {
  /** @param {Uint8Array} data decompressed DocInfo stream */
  constructor(data) {
    const records = parseRecords(data);
    this.records = records;
    const idMap = records.find((r) => r.tag === DOCINFO.ID_MAPPINGS);
    const counts = [];
    if (idMap) {
      const v = viewOf(idMap.data);
      for (let o = 0; o + 4 <= idMap.data.length; o += 4) counts.push(v.getInt32(o, true));
    }
    // FACE_NAME records come language by language, as many as 표 16 index 1–7 says.
    const names = records.filter((r) => r.tag === DOCINFO.FACE_NAME).map(faceName);
    this.faces = {};
    let at = 0;
    LANGS.forEach((lang, i) => {
      const n = counts[i + 1] ?? 0;
      this.faces[lang] = names.slice(at, at + n);
      at += n;
    });
    this.charShapes = records.filter((r) => r.tag === DOCINFO.CHAR_SHAPE).map((r) => charShape(r.data, this.faces));
    this.paraShapes = records.filter((r) => r.tag === DOCINFO.PARA_SHAPE).map((r) => ({
      align: ALIGN[(viewOf(r.data).getUint32(0, true) >>> 2) & 7] ?? 'justify',
    }));
  }

  get modified() {
    return this.records.some((r) => r.modified);
  }

  serialize() {
    return serializeRecords(this.records);
  }

  /**
   * The id of a character shape that is shape `id` with black text: an
   * existing one that differs from it in nothing else, or a copy of it
   * added after the last character shape (a new id, so no reference to an
   * existing shape changes).
   */
  blackVariant(id) {
    const shapes = this.records.filter((r) => r.tag === DOCINFO.CHAR_SHAPE);
    const orig = shapes[id];
    if (!orig || orig.data.length < TEXT_COLOUR + 4) throw new RangeError(`character shape ${id} has no text colour`);
    const colour = (d) => viewOf(d).getUint32(TEXT_COLOUR, true);
    if (colour(orig.data) === 0) return id;
    const same = (d) => d.length === orig.data.length && d.every((x, i) => (i >= TEXT_COLOUR && i < TEXT_COLOUR + 4) || x === orig.data[i]);
    const found = shapes.findIndex((r) => colour(r.data) === 0 && same(r.data));
    if (found >= 0) return found;
    const idMap = this.records.find((r) => r.tag === DOCINFO.ID_MAPPINGS);
    if (!idMap || idMap.data.length < 4 * (CHAR_SHAPE_COUNT + 1) || viewOf(idMap.data).getInt32(4 * CHAR_SHAPE_COUNT, true) !== shapes.length) {
      throw new RangeError('character shape count does not match the ID mappings');
    }
    const data = orig.data.slice();
    viewOf(data).setUint32(TEXT_COLOUR, 0, true);
    this.records.splice(this.records.indexOf(shapes[shapes.length - 1]) + 1, 0, new Record(DOCINFO.CHAR_SHAPE, orig.level, data));
    const counts = idMap.data.slice();
    viewOf(counts).setInt32(4 * CHAR_SHAPE_COUNT, shapes.length + 1, true);
    idMap.setData(counts);
    this.charShapes.push(charShape(data, this.faces));
    return shapes.length;
  }

  /** Problems with the character shape table (for validate.js). */
  check() {
    const n = this.records.filter((r) => r.tag === DOCINFO.CHAR_SHAPE).length;
    const idMap = this.records.find((r) => r.tag === DOCINFO.ID_MAPPINGS);
    const count = idMap && idMap.data.length >= 4 * (CHAR_SHAPE_COUNT + 1) ? viewOf(idMap.data).getInt32(4 * CHAR_SHAPE_COUNT, true) : null;
    return count === n ? [] : [`DocInfo: ${n} character shapes, ID mappings say ${count}`];
  }
}

/** COLORREF 0x00bbggrr (hwp5 표 1) as '#rrggbb'. */
function colourOf(ref) {
  const hex = (x) => x.toString(16).padStart(2, '0');
  return `#${hex(ref & 0xff)}${hex((ref >>> 8) & 0xff)}${hex((ref >>> 16) & 0xff)}`;
}

function faceName(rec) {
  const r = new Reader(rec.data);
  r.u8();
  return r.utf16(r.u16());
}

function charShape(data, faces) {
  const v = viewOf(data);
  const per = (offset, get) => Object.fromEntries(LANGS.map((l, i) => [l, get(offset + i)]));
  // Face ids are WORD[7] at 0; the per-language byte arrays follow (표 33).
  const ids = Object.fromEntries(LANGS.map((l, i) => [l, v.getUint16(2 * i, true)]));
  const attr = v.getUint32(46, true);
  return {
    face: Object.fromEntries(LANGS.map((l) => [l, faces[l]?.[ids[l]] ?? null])),
    ratio: per(14, (o) => v.getUint8(o)),
    spacing: per(21, (o) => v.getInt8(o)),
    relSize: per(28, (o) => v.getUint8(o)),
    /** Base size in HWPUNIT (1/7200 inch; 100 per point). */
    size: v.getInt32(42, true),
    italic: !!(attr & 1),
    bold: !!(attr & 2),
    /** "글꼴에 어울리는 빈칸 사용 여부" (표 35 bit 25). */
    fontSpace: !!(attr & (1 << 25)),
    color: data.length >= TEXT_COLOUR + 4 ? colourOf(v.getUint32(TEXT_COLOUR, true)) : '#000000',
  };
}
