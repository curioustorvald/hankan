// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// An HWP 5.0 document: the compound file, its FileHeader and its body text
// sections (hwp5 §3.1 표 2 p.7, §3.2.3 p.9).
//
// Only BodyText/Section* streams are rewritten, when one of their records
// changed, and DocInfo, when a character shape was added to it (see
// docinfo.js); every other stream (BinData, previews, scripts, summary
// information, ...) is left untouched by the compound file writer.

import { FormatError } from '../util/bytes.js';
import { CompoundFile } from '../container/cfb.js';
import { parseFileHeader, assertEditable, decodeStream, encodeStream } from './stream.js';
import { Section } from './section.js';
import { DocInfo } from './docinfo.js';

export class Hwp5Document {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.format = 'hwp5';
    this.cfb = new CompoundFile(bytes);
    if (!this.cfb.has('FileHeader')) throw new FormatError('compound file has no FileHeader stream');
    this.header = parseFileHeader(this.cfb.read('FileHeader'));
    assertEditable(this.header);
    this.sections = [];
    this.trailers = new Map();
    for (const path of sectionPaths(this.cfb)) {
      const { data, trailer } = decodeStream(this.cfb.read(path), this.header.compressed);
      this.trailers.set(path, trailer);
      this.sections.push(new Section(path, data));
    }
    if (!this.sections.length) throw new FormatError('document has no body text sections');
  }

  /** Fonts, character shapes and paragraph alignment (read on first use). */
  get styles() {
    if (!this._styles) {
      const { data, trailer } = decodeStream(this.cfb.read('DocInfo'), this.header.compressed);
      this._docInfoTrailer = trailer;
      this._styles = new DocInfo(data);
    }
    return this._styles;
  }

  /** A character shape like `id` but with black text (see docinfo.js). */
  blackShape(id) {
    return this.styles.blackVariant(id);
  }

  /** Character shape in effect at `pos` of `paragraph` (see hwp5/docinfo.js). */
  charStyleAt(paragraph, pos) {
    return this.styles.charShapes[paragraph.charShapeIdAt(pos)] ?? null;
  }

  paraAlign(paragraph) {
    return this.styles.paraShapes[paragraph.paraShapeId]?.align ?? 'justify';
  }

  static sniff(bytes) {
    return CompoundFile.isCompoundFile(bytes);
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
      if (!s.modified && !rewriteAll) continue;
      this.cfb.write(s.path, await encodeStream(s.serialize(), this.header.compressed, this.trailers.get(s.path)));
    }
    if (this._styles?.modified) {
      this.cfb.write('DocInfo', await encodeStream(this._styles.serialize(), this.header.compressed, this._docInfoTrailer));
    }
    return this.cfb.toBytes();
  }
}

/** BodyText/Section0, Section1, ... in numeric order. */
function sectionPaths(cfb) {
  return cfb.list()
    .map((e) => /^BodyText\/Section(\d+)$/.exec(e.path))
    .filter((m) => m && cfb.has(m[0]))
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => m[0]);
}
