// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Little-endian byte reading and writing. Generic; no format knowledge.

export class FormatError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'FormatError';
  }
}

export class UnsupportedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'UnsupportedError';
  }
}

export function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Sequential little-endian reader over a Uint8Array. */
export class Reader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.view = viewOf(bytes);
    this.pos = start;
    this.end = end;
  }

  get remaining() { return this.end - this.pos; }

  need(n) {
    if (this.pos + n > this.end) {
      throw new FormatError(`unexpected end of data: need ${n} bytes at ${this.pos}, have ${this.end - this.pos}`);
    }
  }

  u8() { this.need(1); return this.view.getUint8(this.pos++); }
  i8() { this.need(1); return this.view.getInt8(this.pos++); }
  u16() { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { this.need(2); const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { this.need(4); const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  take(n) { this.need(n); const v = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  skip(n) { this.need(n); this.pos += n; }
  /** `n` UTF-16LE code units as a JS string. */
  utf16(n) { return decodeUtf16(this.take(2 * n)); }
}

/** Growable little-endian writer. */
export class Writer {
  constructor(capacity = 256) {
    this.bytes = new Uint8Array(capacity);
    this.view = viewOf(this.bytes);
    this.length = 0;
  }

  reserve(n) {
    if (this.length + n <= this.bytes.length) return;
    let cap = this.bytes.length * 2;
    while (cap < this.length + n) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
    this.view = viewOf(grown);
  }

  u8(v) { this.reserve(1); this.view.setUint8(this.length, v); this.length += 1; return this; }
  u16(v) { this.reserve(2); this.view.setUint16(this.length, v, true); this.length += 2; return this; }
  u32(v) { this.reserve(4); this.view.setUint32(this.length, v >>> 0, true); this.length += 4; return this; }
  i32(v) { this.reserve(4); this.view.setInt32(this.length, v, true); this.length += 4; return this; }
  put(bytes) { this.reserve(bytes.length); this.bytes.set(bytes, this.length); this.length += bytes.length; return this; }
  finish() { return this.bytes.slice(0, this.length); }
}

const utf16Decoder = new TextDecoder('utf-16le');

export function decodeUtf16(bytes) {
  return utf16Decoder.decode(bytes);
}

export function encodeUtf16(str) {
  const out = new Uint8Array(str.length * 2);
  const view = viewOf(out);
  for (let i = 0; i < str.length; i++) view.setUint16(2 * i, str.charCodeAt(i), true);
  return out;
}

export function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
