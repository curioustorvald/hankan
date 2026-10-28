// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// The parts of DocInfo the filler reads: fonts, character shapes and
// paragraph alignment, to work out how wide text will be and what colour
// it is; border/fill records, to draw table cells as the form does; and
// its one edit of DocInfo: adding a black copy of a character
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
//   border/fill: attribute (diagonals),
//     line widths, fill type and colour ...... hwp5 §4.2.5 표 23–24, 26, 28 p.21–23
//
// Corpus observation C12 (PROVENANCE.md): a border/fill record holds each
// side as type, width and colour together (6 bytes; left, right, top,
// bottom), then the diagonal, where 표 23 lists four types, four widths and
// four colours; type 0 is no line and the other types follow 표 25 one up,
// which is the order of owpml-ksx6101 §7.3 LineType2/3; a fill colour whose
// top byte is not 0 is no colour (a line's colour is read from its low 3
// bytes).

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
/** Border line types (C12: 0 is none, then 표 25 one up; names of owpml-ksx6101 §7.3). */
const LINE_TYPES = ['NONE', 'SOLID', 'DOT', 'DASH', 'DASH_DOT', 'DASH_DOT_DOT', 'LONG_DASH', 'CIRCLE',
  'DOUBLE_SLIM', 'SLIM_THICK', 'THICK_SLIM', 'SLIM_THICK_SLIM', 'WAVE', 'DOUBLEWAVE'];
/** Border line widths in mm (표 26). */
const LINE_WIDTHS = [0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];

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
    /** Border/fill ids count from 1 (C12): id n is borderFills[n - 1]. */
    this.borderFills = records.filter((r) => r.tag === DOCINFO.BORDER_FILL).map((r) => borderFill(r.data));
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

/** A fill COLORREF, or null when its top byte is set (C12). */
const colourOrNone = (ref) => (ref >>> 24 ? null : colourOf(ref));

/**
 * A border/fill record as { left, right, top, bottom, diagonal, slash,
 * backSlash, fill }: each line { type, width (mm), color } or null for no
 * line; fill a '#rrggbb' or null.
 */
export function borderFill(data) {
  if (data.length < 32) return null;
  const v = viewOf(data);
  const line = (o) => {
    const type = LINE_TYPES[data[o]] ?? 'SOLID';
    return type === 'NONE' ? null : { type, width: LINE_WIDTHS[data[o + 1]] ?? 0.1, color: colourOf(v.getUint32(o + 2, true) & 0xffffff) };
  };
  const attr = v.getUint16(0, true);
  // 표 28: fill type, then for a solid fill (bit 0) the background colour.
  const solid = data.length >= 40 && (v.getUint32(32, true) & 1);
  return {
    left: line(2), right: line(8), top: line(14), bottom: line(20), diagonal: line(26),
    slash: !!((attr >>> 2) & 7), backSlash: !!((attr >>> 5) & 7),
    fill: solid ? colourOrNone(v.getUint32(36, true)) : null,
  };
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
