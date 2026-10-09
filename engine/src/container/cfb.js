// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Compound File Binary (structured storage) reader and in-place writer.
//
// Source: Microsoft's published Compound File Binary File Format ([MS-CFB]),
// a general-purpose container that is not specific to any document format.
// hwp5 §1 p.5 only states that HWP 5.0 files are built on it.
//
// The writer is deliberately *in place*: saving starts from the original
// bytes, and only the sectors of streams that were replaced are released and
// reallocated (freed sectors are zeroed). Unchanged streams, the directory
// tree, CLSIDs, timestamps and sector layout are kept as they are, so a file
// with no replaced streams is written back byte for byte.

import { FormatError, UnsupportedError, viewOf, decodeUtf16 } from '../util/bytes.js';

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export const FREESECT = 0xffffffff;
export const ENDOFCHAIN = 0xfffffffe;
export const FATSECT = 0xfffffffd;
export const DIFSECT = 0xfffffffc;
const MAXREGSECT = 0xfffffffa;
const NOSTREAM = 0xffffffff;

const HEADER_DIFAT_SLOTS = 109;
const DIR_ENTRY_SIZE = 128;

export const OBJ_STORAGE = 1;
export const OBJ_STREAM = 2;
export const OBJ_ROOT = 5;

export class CompoundFile {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.original = bytes;
    this.#parse(bytes);
    /** @type {Map<number, Uint8Array>} entry id -> replacement contents */
    this.replaced = new Map();
  }

  static isCompoundFile(bytes) {
    return bytes.length >= 512 && SIGNATURE.every((b, i) => bytes[i] === b);
  }

  #parse(bytes) {
    if (!CompoundFile.isCompoundFile(bytes)) throw new FormatError('not a compound file (bad signature)');
    const v = viewOf(bytes);
    const major = v.getUint16(0x1a, true);
    const sectorShift = v.getUint16(0x1e, true);
    const miniShift = v.getUint16(0x20, true);
    if (v.getUint16(0x1c, true) !== 0xfffe) throw new FormatError('compound file: bad byte order mark');
    if (!((major === 3 && sectorShift === 9) || (major === 4 && sectorShift === 12))) {
      throw new UnsupportedError(`compound file: version ${major} with sector shift ${sectorShift}`);
    }
    if (miniShift !== 6) throw new UnsupportedError(`compound file: mini sector shift ${miniShift}`);

    this.major = major;
    this.sectorSize = 1 << sectorShift;
    this.miniSectorSize = 1 << miniShift;
    this.headerSize = this.sectorSize; // header occupies the first "sector" slot
    this.entriesPerSector = this.sectorSize / 4;
    this.miniCutoff = v.getUint32(0x38, true);
    if (this.miniCutoff !== 4096) throw new UnsupportedError(`compound file: mini stream cutoff ${this.miniCutoff}`);

    const numFatSectors = v.getUint32(0x2c, true);
    this.firstDirSector = v.getUint32(0x30, true);
    this.firstMiniFatSector = v.getUint32(0x3c, true);
    this.numMiniFatSectors = v.getUint32(0x40, true);
    this.firstDifatSector = v.getUint32(0x44, true);
    this.numDifatSectors = v.getUint32(0x48, true);

    // Sectors physically present (a truncated final sector still counts).
    this.fileSectors = Math.ceil((bytes.length - this.headerSize) / this.sectorSize);

    // DIFAT: locations of the FAT sectors.
    const difat = [];
    for (let i = 0; i < HEADER_DIFAT_SLOTS; i++) {
      const s = v.getUint32(0x4c + 4 * i, true);
      if (s !== FREESECT) difat.push(s);
    }
    this.difatSectors = [];
    let ds = this.firstDifatSector;
    const seen = new Set();
    while (ds !== ENDOFCHAIN && ds !== FREESECT && this.difatSectors.length < this.numDifatSectors) {
      if (ds > MAXREGSECT || seen.has(ds)) throw new FormatError('compound file: bad DIFAT chain');
      seen.add(ds);
      this.difatSectors.push(ds);
      const off = this.#sectorOffset(ds);
      for (let i = 0; i < this.entriesPerSector - 1; i++) {
        const s = v.getUint32(off + 4 * i, true);
        if (s !== FREESECT) difat.push(s);
      }
      ds = v.getUint32(off + 4 * (this.entriesPerSector - 1), true);
    }
    if (difat.length < numFatSectors) throw new FormatError('compound file: DIFAT lists fewer FAT sectors than the header');
    this.fatSectors = difat.slice(0, numFatSectors);

    // FAT
    this.fat = new Uint32Array(numFatSectors * this.entriesPerSector);
    this.fatSectors.forEach((s, i) => {
      const off = this.#sectorOffset(s);
      for (let j = 0; j < this.entriesPerSector; j++) {
        this.fat[i * this.entriesPerSector + j] = v.getUint32(off + 4 * j, true);
      }
    });

    // Directory
    this.dirChain = this.#chain(this.firstDirSector);
    const dirBytes = this.#readChain(this.dirChain, this.dirChain.length * this.sectorSize);
    this.entries = [];
    for (let off = 0; off + DIR_ENTRY_SIZE <= dirBytes.length; off += DIR_ENTRY_SIZE) {
      this.entries.push(parseDirEntry(dirBytes.subarray(off, off + DIR_ENTRY_SIZE), this.entries.length, this.major));
    }
    const root = this.entries[0];
    if (!root || root.type !== OBJ_ROOT) throw new FormatError('compound file: first directory entry is not the root');
    this.root = root;

    // Mini FAT and mini stream
    const miniFatChain = this.firstMiniFatSector === ENDOFCHAIN ? [] : this.#chain(this.firstMiniFatSector);
    this.miniFatChain = miniFatChain;
    const miniFatBytes = this.#readChain(miniFatChain, miniFatChain.length * this.sectorSize);
    this.miniFat = new Uint32Array(miniFatChain.length * this.entriesPerSector);
    const mv = viewOf(miniFatBytes);
    for (let i = 0; i < this.miniFat.length; i++) this.miniFat[i] = mv.getUint32(4 * i, true);
    this.miniStreamChain = root.start === ENDOFCHAIN || root.size === 0 ? [] : this.#chain(root.start);

    this.#buildPaths();
  }

  #sectorOffset(s) {
    return this.headerSize + s * this.sectorSize;
  }

  /** Follow a FAT chain from `start`, with loop protection. */
  #chain(start, fat = this.fat) {
    const out = [];
    let s = start;
    const limit = fat.length;
    while (s !== ENDOFCHAIN) {
      if (s > MAXREGSECT || s >= fat.length) throw new FormatError(`compound file: chain runs to invalid sector ${s}`);
      if (out.length > limit) throw new FormatError('compound file: cyclic chain');
      out.push(s);
      s = fat[s];
    }
    return out;
  }

  #readChain(chain, size) {
    const out = new Uint8Array(size);
    let p = 0;
    for (const s of chain) {
      if (p >= size) break;
      const off = this.#sectorOffset(s);
      const n = Math.min(this.sectorSize, size - p);
      // A final sector may be truncated in the file; missing bytes stay zero.
      const avail = Math.max(0, Math.min(n, this.original.length - off));
      out.set(this.original.subarray(off, off + avail), p);
      p += n;
    }
    if (p < size) throw new FormatError('compound file: stream shorter than its declared size');
    return out;
  }

  #buildPaths() {
    this.byPath = new Map();
    const visit = (id, prefix, depth, guard) => {
      if (id === NOSTREAM) return;
      if (id >= this.entries.length || guard.has(id) || depth > 64) throw new FormatError('compound file: bad directory tree');
      guard.add(id);
      const e = this.entries[id];
      visit(e.left, prefix, depth + 1, guard);
      e.path = prefix + e.name;
      this.byPath.set(e.path, e);
      if (e.type === OBJ_STORAGE) visit(e.child, e.path + '/', depth + 1, guard);
      visit(e.right, prefix, depth + 1, guard);
    };
    visit(this.root.child, '', 0, new Set());
  }

  /** All storages and streams as slash-separated paths, in tree order. */
  list() {
    return [...this.byPath.values()].map((e) => ({ path: e.path, type: e.type === OBJ_STORAGE ? 'storage' : 'stream', size: e.size }));
  }

  has(path) {
    const e = this.byPath.get(path);
    return !!e && e.type === OBJ_STREAM;
  }

  /** Contents of the stream at `path` (current, i.e. including replacements). */
  read(path) {
    const e = this.byPath.get(path);
    if (!e || e.type !== OBJ_STREAM) throw new FormatError(`compound file: no stream ${path}`);
    if (this.replaced.has(e.id)) return this.replaced.get(e.id);
    return this.#readOriginal(e);
  }

  #readOriginal(e) {
    if (e.size === 0) return new Uint8Array(0);
    if (e.size < this.miniCutoff) {
      const chain = this.#chain(e.start, this.miniFat);
      const out = new Uint8Array(e.size);
      let p = 0;
      for (const m of chain) {
        if (p >= e.size) break;
        const n = Math.min(this.miniSectorSize, e.size - p);
        out.set(this.#readMini(m, n), p);
        p += n;
      }
      if (p < e.size) throw new FormatError(`compound file: mini stream chain of ${e.path} too short`);
      return out;
    }
    return this.#readChain(this.#chain(e.start), e.size);
  }

  #readMini(m, n) {
    const pos = m * this.miniSectorSize;
    const sector = this.miniStreamChain[Math.floor(pos / this.sectorSize)];
    if (sector === undefined) throw new FormatError('compound file: mini sector outside the mini stream');
    const off = this.#sectorOffset(sector) + (pos % this.sectorSize);
    const out = new Uint8Array(n);
    out.set(this.original.subarray(off, Math.min(off + n, this.original.length)));
    return out;
  }

  /** Replace the contents of an existing stream. */
  write(path, bytes) {
    const e = this.byPath.get(path);
    if (!e || e.type !== OBJ_STREAM) throw new FormatError(`compound file: no stream ${path}`);
    this.replaced.set(e.id, bytes);
  }

  /** Serialise. Without replacements this returns a copy of the original bytes. */
  toBytes() {
    if (this.replaced.size === 0) return this.original.slice();
    return new InPlaceWriter(this).run();
  }

  // Internals exposed to the writer.
  get _internals() {
    return {
      chain: (start, fat) => this.#chain(start, fat),
      sectorOffset: (s) => this.#sectorOffset(s),
    };
  }
}

function parseDirEntry(raw, id, major) {
  const v = viewOf(raw);
  const nameLen = v.getUint16(0x40, true);
  const nameChars = Math.max(0, Math.min(32, nameLen / 2) - 1);
  const sizeLow = v.getUint32(0x78, true);
  const sizeHigh = v.getUint32(0x7c, true);
  // Version 3 files may leave garbage in the high half (MS-CFB 2.6.3).
  const size = major === 3 ? sizeLow : sizeHigh * 0x100000000 + sizeLow;
  return {
    id,
    raw: raw.slice(),
    name: decodeUtf16(raw.subarray(0, nameChars * 2)),
    type: v.getUint8(0x42),
    left: v.getUint32(0x44, true),
    right: v.getUint32(0x48, true),
    child: v.getUint32(0x4c, true),
    start: v.getUint32(0x74, true),
    size,
  };
}

/**
 * Applies stream replacements to a copy of the original file:
 * 1. release the sectors (or mini sectors) of every replaced stream;
 * 2. allocate new ones, reusing free space before growing the file;
 * 3. rewrite only the FAT, mini FAT, DIFAT, directory and header sectors that
 *    describe the new allocation.
 */
class InPlaceWriter {
  constructor(cf) {
    this.cf = cf;
    this.ss = cf.sectorSize;
    this.ms = cf.miniSectorSize;
    this.eps = cf.entriesPerSector;
    this.fat = Array.from(cf.fat);
    this.miniFat = Array.from(cf.miniFat);
    this.fatSectors = cf.fatSectors.slice();
    this.difatSectors = cf.difatSectors.slice();
    this.miniFatChain = cf.miniFatChain.slice();
    this.miniStreamChain = cf.miniStreamChain.slice();
    this.miniStreamSize = cf.root.size;
    this.entries = cf.entries.map((e) => ({ ...e }));
    this.freedSectors = new Set();
    this.freedMini = new Set();
    this.sectorData = new Map(); // sector -> Uint8Array(ss) of new contents
    this.freeHint = 0;
    this.miniFreeHint = 0;
  }

  run() {
    const { cf } = this;
    const chain = cf._internals.chain;
    // 1. Release.
    for (const id of cf.replaced.keys()) {
      const e = this.entries[id];
      if (e.size === 0 || e.start === ENDOFCHAIN) continue;
      if (e.size < cf.miniCutoff) {
        for (const m of chain(e.start, this.miniFat)) { this.miniFat[m] = FREESECT; this.freedMini.add(m); }
      } else {
        for (const s of chain(e.start, this.fat)) { this.fat[s] = FREESECT; this.freedSectors.add(s); }
      }
    }
    // 2. Allocate and place the new contents.
    for (const [id, bytes] of cf.replaced) {
      const e = this.entries[id];
      e.size = bytes.length;
      if (bytes.length === 0) {
        e.start = ENDOFCHAIN;
      } else if (bytes.length < cf.miniCutoff) {
        e.start = this.#placeMini(bytes);
      } else {
        e.start = this.#placeRegular(bytes);
      }
    }
    return this.#serialise();
  }

  // ---- regular sectors ---------------------------------------------------

  #allocSector() {
    for (;;) {
      for (let i = this.freeHint; i < this.fat.length; i++) {
        if (this.fat[i] === FREESECT) {
          this.freeHint = i + 1;
          this.fat[i] = ENDOFCHAIN;
          this.freedSectors.delete(i);
          return i;
        }
      }
      this.#growFat();
    }
  }

  /** Add one FAT sector (and a DIFAT sector when the DIFAT is full). */
  #growFat() {
    const base = this.fat.length;
    for (let i = 0; i < this.eps; i++) this.fat.push(FREESECT);
    // The new FAT sector lives in the first free slot (possibly one it describes).
    let s = this.fat.indexOf(FREESECT, this.freeHint);
    if (s < 0) s = base;
    this.fat[s] = FATSECT;
    this.fatSectors.push(s);
    const capacity = HEADER_DIFAT_SLOTS + this.difatSectors.length * (this.eps - 1);
    if (this.fatSectors.length > capacity) {
      const d = this.fat.indexOf(FREESECT, this.freeHint);
      this.fat[d] = DIFSECT;
      this.difatSectors.push(d);
    }
  }

  #placeRegular(bytes) {
    const n = Math.ceil(bytes.length / this.ss);
    const sectors = [];
    for (let i = 0; i < n; i++) sectors.push(this.#allocSector());
    for (let i = 0; i < n; i++) {
      this.fat[sectors[i]] = i + 1 < n ? sectors[i + 1] : ENDOFCHAIN;
      const buf = new Uint8Array(this.ss);
      buf.set(bytes.subarray(i * this.ss, Math.min((i + 1) * this.ss, bytes.length)));
      this.sectorData.set(sectors[i], buf);
    }
    return sectors[0];
  }

  /** Append a regular sector to a chain; returns the new chain array. */
  #extendChain(chainArr) {
    const s = this.#allocSector();
    if (chainArr.length) this.fat[chainArr[chainArr.length - 1]] = s;
    chainArr.push(s);
    this.sectorData.set(s, new Uint8Array(this.ss));
    return s;
  }

  // ---- mini sectors ------------------------------------------------------

  #allocMini() {
    for (;;) {
      for (let i = this.miniFreeHint; i < this.miniFat.length; i++) {
        if (this.miniFat[i] === FREESECT) {
          this.miniFreeHint = i + 1;
          this.miniFat[i] = ENDOFCHAIN;
          this.freedMini.delete(i);
          return i;
        }
      }
      // Grow the mini FAT by one sector.
      this.#extendChain(this.miniFatChain);
      for (let i = 0; i < this.eps; i++) this.miniFat.push(FREESECT);
    }
  }

  #placeMini(bytes) {
    const n = Math.ceil(bytes.length / this.ms);
    const minis = [];
    for (let i = 0; i < n; i++) minis.push(this.#allocMini());
    for (let i = 0; i < n; i++) {
      this.miniFat[minis[i]] = i + 1 < n ? minis[i + 1] : ENDOFCHAIN;
      const chunk = new Uint8Array(this.ms);
      chunk.set(bytes.subarray(i * this.ms, Math.min((i + 1) * this.ms, bytes.length)));
      this.#writeMini(minis[i], chunk);
    }
    return minis[0];
  }

  #miniSectorLocation(m) {
    const pos = m * this.ms;
    const needSize = pos + this.ms;
    while (this.miniStreamChain.length * this.ss < needSize) this.#extendChain(this.miniStreamChain);
    if (this.miniStreamSize < needSize) this.miniStreamSize = needSize;
    return { sector: this.miniStreamChain[Math.floor(pos / this.ss)], offset: pos % this.ss };
  }

  #sectorBuffer(s) {
    let buf = this.sectorData.get(s);
    if (!buf) {
      buf = new Uint8Array(this.ss);
      const off = this.cf._internals.sectorOffset(s);
      buf.set(this.cf.original.subarray(off, Math.min(off + this.ss, this.cf.original.length)));
      this.sectorData.set(s, buf);
    }
    return buf;
  }

  #writeMini(m, chunk) {
    const { sector, offset } = this.#miniSectorLocation(m);
    this.#sectorBuffer(sector).set(chunk, offset);
  }

  // ---- output ------------------------------------------------------------

  #serialise() {
    const { cf, ss, eps } = this;
    // Zero released space that was not reused.
    for (const m of this.freedMini) this.#writeMini(m, new Uint8Array(this.ms));
    for (const s of this.freedSectors) this.sectorData.set(s, new Uint8Array(ss));

    // Mini FAT sectors
    this.miniFatChain.forEach((s, i) => {
      const buf = this.#sectorBuffer(s);
      const v = viewOf(buf);
      for (let j = 0; j < eps; j++) v.setUint32(4 * j, this.miniFat[i * eps + j] ?? FREESECT, true);
    });
    if (this.miniFatChain.length) {
      for (let i = 0; i < this.miniFatChain.length; i++) {
        this.fat[this.miniFatChain[i]] = i + 1 < this.miniFatChain.length ? this.miniFatChain[i + 1] : ENDOFCHAIN;
      }
    }

    // Directory entries: only start and size change.
    const root = this.entries[0];
    root.start = this.miniStreamChain.length ? this.miniStreamChain[0] : ENDOFCHAIN;
    root.size = this.miniStreamChain.length ? this.miniStreamSize : 0;
    const changedEntries = new Set([0, ...cf.replaced.keys()]);
    for (const id of changedEntries) {
      const e = this.entries[id];
      const raw = e.raw.slice();
      const v = viewOf(raw);
      v.setUint32(0x74, e.start, true);
      v.setUint32(0x78, e.size % 0x100000000, true);
      v.setUint32(0x7c, cf.major === 3 ? 0 : Math.floor(e.size / 0x100000000), true);
      const pos = id * DIR_ENTRY_SIZE;
      const sector = cf.dirChain[Math.floor(pos / ss)];
      this.#sectorBuffer(sector).set(raw, pos % ss);
    }

    // FAT sectors
    this.fatSectors.forEach((s, i) => {
      const buf = this.#sectorBuffer(s);
      const v = viewOf(buf);
      for (let j = 0; j < eps; j++) v.setUint32(4 * j, this.fat[i * eps + j], true);
    });

    // DIFAT sectors
    const overflow = this.fatSectors.slice(HEADER_DIFAT_SLOTS);
    this.difatSectors.forEach((s, i) => {
      const buf = this.#sectorBuffer(s);
      const v = viewOf(buf);
      for (let j = 0; j < eps - 1; j++) v.setUint32(4 * j, overflow[i * (eps - 1) + j] ?? FREESECT, true);
      v.setUint32(4 * (eps - 1), i + 1 < this.difatSectors.length ? this.difatSectors[i + 1] : ENDOFCHAIN, true);
    });

    // Assemble: original bytes, grown to cover every allocated sector.
    let lastUsed = -1;
    for (let i = this.fat.length - 1; i >= 0; i--) if (this.fat[i] !== FREESECT) { lastUsed = i; break; }
    const length = Math.max(cf.original.length, cf.headerSize + (lastUsed + 1) * ss);
    const out = new Uint8Array(length);
    out.set(cf.original);
    for (const [s, buf] of this.sectorData) {
      const off = cf.headerSize + s * ss;
      out.set(buf.subarray(0, Math.min(ss, length - off)), off);
    }

    // Header
    const hv = viewOf(out);
    hv.setUint32(0x2c, this.fatSectors.length, true);
    hv.setUint32(0x3c, this.miniFatChain.length ? this.miniFatChain[0] : ENDOFCHAIN, true);
    hv.setUint32(0x40, this.miniFatChain.length, true);
    hv.setUint32(0x44, this.difatSectors.length ? this.difatSectors[0] : ENDOFCHAIN, true);
    hv.setUint32(0x48, this.difatSectors.length, true);
    for (let i = 0; i < HEADER_DIFAT_SLOTS; i++) {
      hv.setUint32(0x4c + 4 * i, this.fatSectors[i] ?? FREESECT, true);
    }
    return out;
  }
}
