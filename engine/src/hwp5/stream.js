// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// FileHeader and stream compression of HWP 5.0.
//
// FileHeader layout: hwp5 §3.2.1 표 3 p.8. Which streams are compressed:
// hwp5 표 2 p.7 and the text below it (DocInfo, BodyText/Section*,
// DocHistory are record streams that may be compressed). The compressor
// is zlib's DEFLATE: hwp5 §1 p.5.
//
// Corpus observation (PROVENANCE.md, "C1"): every compressed record stream
// in the corpus is a raw DEFLATE stream followed by an 8-byte trailer, the
// CRC-32 and the length of the uncompressed data (both little-endian). The
// spec does not describe this trailer. The reader accepts streams with or
// without it; the writer reproduces whatever the original stream had.

import { FormatError, UnsupportedError, Reader, viewOf, concat } from '../util/bytes.js';
import { inflate, deflateRaw } from '../util/deflate.js';
import { crc32 } from '../util/crc32.js';

const SIGNATURE = 'HWP Document File';

/** Bits of the FileHeader property DWORD (hwp5 표 3). */
export const HEADER_FLAG = Object.freeze({
  COMPRESSED: 1 << 0,
  PASSWORD: 1 << 1,
  DISTRIBUTION: 1 << 2,
  SCRIPT: 1 << 3,
  DRM: 1 << 4,
  XML_TEMPLATE: 1 << 5,
  HISTORY: 1 << 6,
  SIGNATURE: 1 << 7,
  CERT_ENCRYPTED: 1 << 8,
  SIGNATURE_SPARE: 1 << 9,
  CERT_DRM: 1 << 10,
  CCL: 1 << 11,
  MOBILE: 1 << 12,
  PRIVACY: 1 << 13,
  TRACK_CHANGES: 1 << 14,
  KOGL: 1 << 15,
  VIDEO: 1 << 16,
  TOC_FIELD: 1 << 17,
});

export function parseFileHeader(bytes) {
  if (bytes.length < 256 - 207) throw new FormatError('FileHeader too short');
  const r = new Reader(bytes);
  const sig = new TextDecoder('latin1').decode(r.take(32)).replace(/\0+$/, '');
  if (sig !== SIGNATURE) throw new FormatError(`not an HWP 5 document (signature ${JSON.stringify(sig)})`);
  const version = r.u32();
  const flags = r.u32();
  const license = r.u32();
  const encryptVersion = r.u32();
  return {
    version: {
      major: version >>> 24, minor: (version >>> 16) & 0xff, build: (version >>> 8) & 0xff, revision: version & 0xff,
      raw: version,
      toString() { return `${this.major}.${this.minor}.${this.build}.${this.revision}`; },
    },
    flags,
    license,
    encryptVersion,
    compressed: !!(flags & HEADER_FLAG.COMPRESSED),
  };
}

/** Refuse documents whose content cannot be read or rewritten without keys. */
export function assertEditable(header) {
  const f = header.flags;
  if (header.version.major !== 5) throw new UnsupportedError(`HWP format version ${header.version} (only 5.x is supported)`);
  if (f & HEADER_FLAG.PASSWORD) throw new UnsupportedError('password-protected document');
  if (f & HEADER_FLAG.DISTRIBUTION) throw new UnsupportedError('distribution (read-only) document');
  if (f & (HEADER_FLAG.DRM | HEADER_FLAG.CERT_DRM | HEADER_FLAG.CERT_ENCRYPTED)) throw new UnsupportedError('DRM-protected document');
}

/**
 * Decode a (possibly compressed) record stream.
 * @returns {{ data: Uint8Array, trailer: boolean }}
 */
export function decodeStream(bytes, compressed) {
  if (!compressed) return { data: bytes, trailer: false };
  const { data, consumed } = inflate(bytes);
  const rest = bytes.length - consumed;
  let trailer = false;
  if (rest === 8) {
    const v = viewOf(bytes.subarray(consumed));
    if (v.getUint32(0, true) !== crc32(data) || v.getUint32(4, true) !== data.length) {
      throw new FormatError('compressed stream: trailer does not match its contents');
    }
    trailer = true;
  } else if (rest !== 0) {
    throw new FormatError(`compressed stream: ${rest} unexpected bytes after the data`);
  }
  return { data, trailer };
}

export async function encodeStream(data, compressed, trailer) {
  if (!compressed) return data;
  const packed = await deflateRaw(data);
  if (!trailer) return packed;
  const t = new Uint8Array(8);
  const v = viewOf(t);
  v.setUint32(0, crc32(data), true);
  v.setUint32(4, data.length, true);
  return concat([packed, t]);
}
