// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// The parts of Contents/header.xml the filler reads: fonts, character
// properties and paragraph alignment, in the same shape as hwp5/docinfo.js;
// and its one edit of the header: adding a black copy of a charPr, for text
// written over coloured text.
//
// Sources (owpml-ksx6101): fontfaces / fontface (lang) / font (id, face)
// §9.3.2; charProperties (itemCnt) §9.3.4.1; charPr (id, height,
// textColor, useFontSpace) with fontRef, ratio, spacing, relSz, bold,
// italic §9.3.4.2 (textColor defaults to #000000: Annex XSD); paraPr /
// align (horizontal) §9.3.8.2.2.

import { XmlDocument } from './xml.js';

const LANG = { HANGUL: 'hangul', LATIN: 'latin', HANJA: 'hanja', JAPANESE: 'japanese', OTHER: 'other', SYMBOL: 'symbol', USER: 'user' };
export const LANGS = Object.values(LANG);
const ALIGN = { JUSTIFY: 'justify', LEFT: 'left', RIGHT: 'right', CENTER: 'center', DISTRIBUTE: 'distribute', DISTRIBUTE_SPACE: 'divide' };

export class HwpxHeader {
  /** @param {string} src header.xml */
  constructor(src) {
    this.xml = new XmlDocument(src);
    const root = this.xml.root;
    const all = (local) => [...root.descendants(local)];
    this.faces = Object.fromEntries(LANGS.map((l) => [l, []]));
    for (const ff of all('fontface')) {
      const lang = LANG[ff.attr('lang')];
      if (!lang) continue;
      for (const f of ff.all('font')) this.faces[lang][Number(f.attr('id'))] = f.attr('face') ?? null;
    }
    this.charShapes = [];
    for (const cp of all('charPr')) {
      const per = (local, fallback) => {
        const el = cp.first(local);
        return Object.fromEntries(LANGS.map((l) => [l, el?.attr(l) !== undefined ? Number(el.attr(l)) : fallback]));
      };
      const ids = per('fontRef', 0);
      this.charShapes[Number(cp.attr('id'))] = {
        face: Object.fromEntries(LANGS.map((l) => [l, this.faces[l][ids[l]] ?? null])),
        ratio: per('ratio', 100),
        spacing: per('spacing', 0),
        relSize: per('relSz', 100),
        size: Number(cp.attr('height') ?? 1000),
        italic: !!cp.first('italic'),
        bold: !!cp.first('bold'),
        fontSpace: cp.attr('useFontSpace') === '1' || cp.attr('useFontSpace') === 'true',
        color: (cp.attr('textColor') ?? '#000000').toLowerCase(),
      };
    }
    this.paraShapes = [];
    for (const pp of all('paraPr')) {
      this.paraShapes[Number(pp.attr('id'))] = { align: ALIGN[[...pp.descendants('align')][0]?.attr('horizontal')] ?? 'justify' };
    }
  }

  get modified() {
    return this.xml.edits > 0;
  }

  serialize() {
    return this.xml.src;
  }

  /**
   * The id of a charPr that is charPr `id` with black text: an existing one
   * that differs from it in nothing else, or a copy of it with the next free
   * id, added after the last charPr.
   */
  blackVariant(id) {
    const list = [...this.xml.root.descendants('charPr')];
    const el = list.find((e) => Number(e.attr('id')) === id);
    if (!el) throw new RangeError(`there is no charPr ${id}`);
    const colour = (e) => (e.attr('textColor') ?? '#000000').toLowerCase();
    if (colour(el) === '#000000') return id;
    // The element's text without its id and colour, to compare with the others.
    const rest = (e) => this.xml.text(e).replace(/\sid\s*=\s*(["'])[^"']*\1/, '').replace(/\stextColor\s*=\s*(["'])[^"']*\1/, '');
    const key = rest(el);
    const found = list.find((e) => colour(e) === '#000000' && rest(e) === key);
    if (found) return Number(found.attr('id'));
    const container = el.parent;
    const next = Math.max(...list.map((e) => Number(e.attr('id')) || 0)) + 1;
    const xml = this.xml.text(el)
      .replace(/(\sid\s*=\s*)(["'])[^"']*\2/, `$1$2${next}$2`)
      .replace(/(\stextColor\s*=\s*)(["'])[^"']*\2/, '$1$2#000000$2');
    const siblings = container.children.filter((c) => c.type === 'element' && c.local === 'charPr');
    this.xml.insertChildren(container, container.children.indexOf(siblings[siblings.length - 1]) + 1, xml);
    if (container.attr('itemCnt') !== undefined) this.xml.setAttr(container, 'itemCnt', String(siblings.length + 1));
    this.charShapes[next] = { ...this.charShapes[id], color: '#000000' };
    return next;
  }

  /** Problems with the charPr table (for validate.js). */
  check() {
    const problems = [];
    for (const cps of this.xml.root.descendants('charProperties')) {
      const n = cps.all('charPr').length;
      if (cps.attr('itemCnt') !== undefined && Number(cps.attr('itemCnt')) !== n) problems.push(`header: ${n} charPr, itemCnt ${cps.attr('itemCnt')}`);
    }
    const ids = [...this.xml.root.descendants('charPr')].map((e) => e.attr('id'));
    if (new Set(ids).size !== ids.length) problems.push('header: repeated charPr id');
    return problems;
  }
}
