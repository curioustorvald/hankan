// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Data records (hwp5 §4.1 p.16).
//
// A record header is one DWORD: bits 0–9 tag id, 10–19 level, 20–31 size.
// A size field of 0xFFF means the size (4095 bytes or more) follows as a
// DWORD (hwp5 그림 45, 그림 46 p.16).
//
// Records keep the exact bytes they were read from. Serialising a record
// that was not modified reproduces those bytes, so a stream whose records
// were not touched is written back unchanged.

import { FormatError, viewOf, concat } from '../util/bytes.js';

const SIZE_EXTENDED = 0xfff;

export class Record {
  /**
   * @param {number} tag
   * @param {number} level
   * @param {Uint8Array} data
   * @param {Uint8Array|null} raw original header + data, or null for a new record
   */
  constructor(tag, level, data, raw = null) {
    this.tag = tag;
    this.level = level;
    this.data = data;
    this.raw = raw;
  }

  /** Replace the record's data; the record is re-encoded on output. */
  setData(data) {
    this.data = data;
    this.raw = null;
  }

  get modified() { return this.raw === null; }

  encode() {
    if (this.raw) return this.raw;
    const size = this.data.length;
    const extended = size >= SIZE_EXTENDED;
    const out = new Uint8Array((extended ? 8 : 4) + size);
    const v = viewOf(out);
    v.setUint32(0, ((this.tag & 0x3ff) | ((this.level & 0x3ff) << 10) | ((extended ? SIZE_EXTENDED : size) << 20)) >>> 0, true);
    if (extended) v.setUint32(4, size, true);
    out.set(this.data, extended ? 8 : 4);
    return out;
  }
}

/** Split a decompressed record stream into records. */
export function parseRecords(bytes) {
  const v = viewOf(bytes);
  const out = [];
  let p = 0;
  while (p < bytes.length) {
    if (p + 4 > bytes.length) throw new FormatError(`record header truncated at ${p}`);
    const h = v.getUint32(p, true);
    const tag = h & 0x3ff;
    const level = (h >>> 10) & 0x3ff;
    let size = h >>> 20;
    let q = p + 4;
    if (size === SIZE_EXTENDED) {
      if (q + 4 > bytes.length) throw new FormatError(`record size truncated at ${p}`);
      size = v.getUint32(q, true);
      q += 4;
    }
    if (q + size > bytes.length) throw new FormatError(`record at ${p} (tag ${tag}) runs past the end of the stream`);
    out.push(new Record(tag, level, bytes.subarray(q, q + size), bytes.subarray(p, q + size)));
    p = q + size;
  }
  return out;
}

export function serializeRecords(records) {
  return concat(records.map((r) => r.encode()));
}
