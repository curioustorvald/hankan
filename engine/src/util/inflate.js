// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Synchronous DEFLATE decoder (RFC 1951). Generic.
//
// Written here rather than using the platform's DecompressionStream because
// that rejects data after the end of the compressed stream, and it is async.
// `inflate` reports how many input bytes the stream used, so callers decide
// what any following bytes mean.

import { FormatError } from './bytes.js';

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Canonical Huffman decoding table: counts per length and symbols by code. */
function buildHuffman(lengths) {
  const counts = new Uint16Array(16);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  return { counts, symbols };
}

let FIXED_LIT;
let FIXED_DIST;
function fixedTables() {
  if (!FIXED_LIT) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    FIXED_LIT = buildHuffman(l);
    FIXED_DIST = buildHuffman(new Uint8Array(30).fill(5));
  }
  return [FIXED_LIT, FIXED_DIST];
}

class BitReader {
  constructor(bytes) { this.b = bytes; this.pos = 0; this.bit = 0; this.cnt = 0; }
  bits(n) {
    while (this.cnt < n) {
      if (this.pos >= this.b.length) throw new FormatError('deflate: unexpected end of data');
      this.bit |= this.b[this.pos++] << this.cnt;
      this.cnt += 8;
    }
    const v = this.bit & ((1 << n) - 1);
    this.bit >>>= n;
    this.cnt -= n;
    return v;
  }
  decode(h) {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1);
      const count = h.counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new FormatError('deflate: bad Huffman code');
  }
  alignToByte() { this.bit = 0; this.cnt = 0; }
}

class Output {
  constructor(hint) { this.buf = new Uint8Array(Math.max(1024, hint)); this.n = 0; }
  ensure(k) {
    if (this.n + k <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.n + k) cap *= 2;
    const g = new Uint8Array(cap); g.set(this.buf.subarray(0, this.n)); this.buf = g;
  }
}

/**
 * Inflate raw DEFLATE data.
 * @returns {{ data: Uint8Array, consumed: number }}
 */
export function inflate(bytes, sizeHint = bytes.length * 4) {
  const br = new BitReader(bytes);
  const out = new Output(sizeHint);
  let final = 0;
  while (!final) {
    final = br.bits(1);
    const type = br.bits(2);
    if (type === 0) {
      br.alignToByte();
      if (br.pos + 4 > bytes.length) throw new FormatError('deflate: truncated stored block');
      const len = bytes[br.pos] | (bytes[br.pos + 1] << 8);
      const nlen = bytes[br.pos + 2] | (bytes[br.pos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new FormatError('deflate: stored block length check failed');
      br.pos += 4;
      if (br.pos + len > bytes.length) throw new FormatError('deflate: truncated stored block');
      out.ensure(len);
      out.buf.set(bytes.subarray(br.pos, br.pos + len), out.n);
      out.n += len;
      br.pos += len;
    } else if (type === 1 || type === 2) {
      let lit, dist;
      if (type === 1) {
        [lit, dist] = fixedTables();
      } else {
        const hlit = br.bits(5) + 257, hdist = br.bits(5) + 1, hclen = br.bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = br.bits(3);
        const clh = buildHuffman(cl);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const sym = br.decode(clh);
          if (sym < 16) { lens[i++] = sym; continue; }
          let rep, val = 0;
          if (sym === 16) {
            if (i === 0) throw new FormatError('deflate: repeat with no previous length');
            val = lens[i - 1]; rep = 3 + br.bits(2);
          } else if (sym === 17) rep = 3 + br.bits(3);
          else rep = 11 + br.bits(7);
          if (i + rep > lens.length) throw new FormatError('deflate: code lengths overflow');
          lens.fill(val, i, i + rep); i += rep;
        }
        lit = buildHuffman(lens.subarray(0, hlit));
        dist = buildHuffman(lens.subarray(hlit));
      }
      for (;;) {
        const sym = br.decode(lit);
        if (sym < 256) {
          out.ensure(1);
          out.buf[out.n++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const li = sym - 257;
          if (li >= 29) throw new FormatError('deflate: bad length symbol');
          const len = LEN_BASE[li] + br.bits(LEN_EXTRA[li]);
          const di = br.decode(dist);
          if (di >= 30) throw new FormatError('deflate: bad distance symbol');
          const d = DIST_BASE[di] + br.bits(DIST_EXTRA[di]);
          if (d > out.n) throw new FormatError('deflate: distance beyond output');
          out.ensure(len);
          const buf = out.buf;
          for (let k = 0; k < len; k++) { buf[out.n] = buf[out.n - d]; out.n++; }
        }
      }
    } else {
      throw new FormatError('deflate: reserved block type');
    }
  }
  // Bytes consumed: whole bytes read, minus any whole bytes still buffered.
  const consumed = br.pos - (br.cnt >> 3);
  return { data: out.buf.slice(0, out.n), consumed };
}
