// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// An OWPML (.hwpx) document: an OCF/ZIP container (owpml-ksx6101 §8.1–8.2)
// whose body is one XML file per section, Contents/section0.xml,
// section1.xml, ... (owpml-ksx6101 §8.2, §10.2).
//
// Only section entries whose XML was edited are rewritten, and
// Contents/header.xml when a charPr was added to it (see header.js); every
// other entry of the archive is copied byte for byte.

import { FormatError, UnsupportedError } from '../util/bytes.js';
import { ZipArchive } from '../container/zip.js';
import { HwpxSection } from './section.js';
import { HwpxHeader } from './header.js';

const SECTION = /^Contents\/section(\d+)\.xml$/;

export class HwpxDocument {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.format = 'hwpx';
    this.zip = new ZipArchive(bytes);
    if (this.zip.has('mimetype')) {
      const mime = this.zip.readText('mimetype').trim();
      if (mime !== 'application/hwp+zip') throw new FormatError(`unexpected mimetype ${JSON.stringify(mime)}`);
    }
    if (this.zip.has('META-INF/encryption.xml')) throw new UnsupportedError('encrypted document');
    const paths = this.zip.list()
      .map((e) => SECTION.exec(e.name))
      .filter(Boolean)
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map((m) => m[0]);
    if (!paths.length) throw new FormatError('archive has no Contents/section*.xml');
    this.sections = paths.map((p) => new HwpxSection(p, readXml(this.zip, p)));
  }

  /** Fonts, character properties and paragraph alignment (read on first use). */
  get styles() {
    this._styles ??= new HwpxHeader(this.zip.has('Contents/header.xml') ? readXml(this.zip, 'Contents/header.xml') : '<head/>');
    return this._styles;
  }

  /** Character properties in effect at `pos` of `paragraph` (see hwpx/header.js). */
  charStyleAt(paragraph, pos) {
    return this.styles.charShapes[paragraph.charShapeIdAt(pos)] ?? null;
  }

  /** A charPr like `id` but with black text (see header.js). */
  blackShape(id) {
    if (!this.zip.has('Contents/header.xml')) throw new RangeError('document has no header.xml');
    return this.styles.blackVariant(id);
  }

  paraAlign(paragraph) {
    return this.styles.paraShapes[paragraph.paraShapeId]?.align ?? 'justify';
  }

  static sniff(bytes) {
    return ZipArchive.isZip(bytes);
  }

  *walk() {
    for (const [index, section] of this.sections.entries()) {
      for (const item of section.walk()) yield { section: index, ...item };
    }
  }

  get modified() {
    return this.sections.some((s) => s.modified) || !!this._styles?.modified;
  }

  /** @param {{ rewriteAll?: boolean }} [options] rewriteAll re-encodes unchanged sections too (for testing the writer) */
  async toBytes({ rewriteAll = false } = {}) {
    for (const s of this.sections) {
      if (s.modified || rewriteAll) this.zip.write(s.path, new TextEncoder().encode(s.serialize()));
    }
    if (this._styles?.modified) this.zip.write('Contents/header.xml', new TextEncoder().encode(this._styles.serialize()));
    return this.zip.toBytes();
  }
}

function readXml(zip, path) {
  const bytes = zip.read(path);
  // Keep a byte order mark, if any, so that unedited text round-trips.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const decl = /^﻿?<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/.exec(text);
  if (decl && decl[1].toLowerCase() !== 'utf-8') throw new UnsupportedError(`${path}: XML encoding ${decl[1]}`);
  return text;
}
