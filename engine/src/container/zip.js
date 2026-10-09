// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// ZIP archive reader and entry-preserving writer.
//
// Source: PKWARE's ZIP File Format Specification (APPNOTE.TXT), a general
// container format. owpml-ksx6101 §8.1–8.2 only states that an OWPML (.hwpx)
// document is an OCF container, which is a ZIP archive.
//
// The writer keeps every entry it was not asked to replace exactly as it was
// (local header, compressed data and data descriptor are copied verbatim),
// in the original order. Replaced entries keep their name, timestamps,
// extra fields and compression method; only the data, CRC and sizes change.

import { FormatError, UnsupportedError, viewOf, concat } from '../util/bytes.js';
import { crc32 } from '../util/crc32.js';
import { inflateRaw, deflateRaw } from '../util/deflate.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_DESCRIPTOR = 0x08074b50;

export const METHOD_STORED = 0;
export const METHOD_DEFLATE = 8;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;

export class ZipArchive {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.original = bytes;
    this.entries = parseArchive(bytes);
    this.byName = new Map(this.entries.map((e) => [e.name, e]));
    /** @type {Map<string, Uint8Array>} name -> new uncompressed contents */
    this.replaced = new Map();
  }

  static isZip(bytes) {
    return bytes.length >= 4 && viewOf(bytes).getUint32(0, true) === SIG_LOCAL;
  }

  list() {
    return this.entries.map((e) => ({ name: e.name, method: e.method, size: e.usize, compressedSize: e.csize }));
  }

  has(name) { return this.byName.has(name); }

  /** Uncompressed contents of entry `name` (including replacements). */
  read(name) {
    if (this.replaced.has(name)) return this.replaced.get(name);
    const e = this.byName.get(name);
    if (!e) throw new FormatError(`zip: no entry ${name}`);
    const data = this.original.subarray(e.dataStart, e.dataStart + e.csize);
    let out;
    if (e.method === METHOD_STORED) out = data.slice();
    else if (e.method === METHOD_DEFLATE) out = inflateRaw(data, e.usize);
    else throw new UnsupportedError(`zip: compression method ${e.method} for ${name}`);
    if (out.length !== e.usize) throw new FormatError(`zip: ${name} inflated to ${out.length} bytes, expected ${e.usize}`);
    if (crc32(out) !== e.crc) throw new FormatError(`zip: CRC mismatch in ${name}`);
    return out;
  }

  readText(name) {
    return new TextDecoder('utf-8', { fatal: true }).decode(this.read(name));
  }

  /** Replace the contents of an existing entry. */
  write(name, bytes) {
    if (!this.byName.has(name)) throw new FormatError(`zip: no entry ${name}`);
    this.replaced.set(name, bytes);
  }

  async toBytes() {
    if (this.replaced.size === 0) return this.original.slice();
    const chunks = [];
    const centrals = new Array(this.entries.length);
    let offset = 0;
    for (const e of this.entries) {
      let local;
      let central = e.centralRaw.slice();
      const cv = viewOf(central);
      if (this.replaced.has(e.name)) {
        const data = this.replaced.get(e.name);
        const packed = e.method === METHOD_STORED ? data : await deflateRaw(data);
        const crc = crc32(data);
        const flags = e.flags & ~FLAG_DESCRIPTOR;
        const header = this.original.slice(e.localOffset, e.dataStart);
        const hv = viewOf(header);
        hv.setUint16(6, flags, true);
        hv.setUint32(14, crc, true);
        hv.setUint32(18, packed.length, true);
        hv.setUint32(22, data.length, true);
        local = concat([header, packed]);
        cv.setUint16(8, flags, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, packed.length, true);
        cv.setUint32(24, data.length, true);
      } else {
        local = this.original.subarray(e.localOffset, e.localEnd);
      }
      cv.setUint32(42, offset, true);
      chunks.push(local);
      centrals[e.cdIndex] = central;
      offset += local.length;
    }
    const cdOffset = offset;
    const cd = concat(centrals);
    const eocd = this.original.slice(this.eocdOffset, this.original.length);
    const ev = viewOf(eocd);
    ev.setUint32(12, cd.length, true);
    ev.setUint32(16, cdOffset, true);
    return concat([...chunks, cd, eocd]);
  }

  get eocdOffset() { return this.entries.eocdOffset; }
}

function findEocd(bytes) {
  const v = viewOf(bytes);
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  // Prefer a record whose comment ends the file; otherwise accept the last
  // record that fits (some downloads carry a few stray bytes at the end).
  let loose = -1;
  for (let p = bytes.length - 22; p >= min; p--) {
    if (v.getUint32(p, true) !== SIG_EOCD) continue;
    const end = p + 22 + v.getUint16(p + 20, true);
    if (end === bytes.length) return p;
    if (end < bytes.length && loose < 0) loose = p;
  }
  if (loose >= 0) return loose;
  throw new FormatError('zip: end of central directory not found');
}

function parseArchive(bytes) {
  const v = viewOf(bytes);
  const eocd = findEocd(bytes);
  if (eocd >= 20 && v.getUint32(eocd - 20, true) === SIG_EOCD64_LOCATOR) throw new UnsupportedError('zip: ZIP64 archives');
  if (v.getUint16(eocd + 4, true) !== 0 || v.getUint16(eocd + 6, true) !== 0) throw new UnsupportedError('zip: multi-disk archives');
  const count = v.getUint16(eocd + 10, true);
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  if (cdOffset + cdSize > eocd) throw new FormatError('zip: central directory overlaps its end record');

  const entries = [];
  let p = cdOffset;
  const utf8 = new TextDecoder('utf-8');
  const latin = new TextDecoder('latin1');
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== SIG_CENTRAL) throw new FormatError('zip: bad central directory entry');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const localOffset = v.getUint32(p + 42, true);
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & FLAG_UTF8 ? utf8 : isAscii(nameBytes) ? utf8 : latin).decode(nameBytes);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (flags & FLAG_ENCRYPTED) throw new UnsupportedError(`zip: encrypted entry ${name}`);
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) throw new UnsupportedError('zip: ZIP64 entry');

    if (v.getUint32(localOffset, true) !== SIG_LOCAL) throw new FormatError(`zip: bad local header for ${name}`);
    const lNameLen = v.getUint16(localOffset + 26, true);
    const lExtraLen = v.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    let localEnd = dataStart + csize;
    if (flags & FLAG_DESCRIPTOR) {
      localEnd += v.getUint32(localEnd, true) === SIG_DESCRIPTOR ? 16 : 12;
    }
    entries.push({ name, flags, method, crc, csize, usize, localOffset, dataStart, localEnd, cdIndex: i, centralRaw: bytes.slice(p, end) });
    p = end;
  }
  // Data is written back in stored (local header) order; the central
  // directory keeps its own order through `cdIndex`.
  entries.sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 0; i + 1 < entries.length; i++) {
    if (entries[i].localEnd > entries[i + 1].localOffset) throw new FormatError('zip: overlapping entries');
  }
  entries.eocdOffset = eocd;
  return entries;
}

function isAscii(b) {
  for (const x of b) if (x > 0x7f) return false;
  return true;
}
