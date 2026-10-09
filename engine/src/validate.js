// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Structural self-checks of a document. Run on every output before it is
// written, so that a filler bug produces an error instead of a damaged
// file. The checks are the invariants that hold for every document of the
// corpus (tools/check/corpus.js), with sources given there and in the
// paragraph modules.

import { Hwp5Document } from './hwp5/document.js';
import { controlMaskOf, PARA_END } from './hwp5/paragraph.js';
import { parseRecords } from './hwp5/records.js';
import { parseXml } from './hwpx/xml.js';

/** @returns {string[]} problems found (empty when the document is sound) */
export function validate(doc) {
  return doc instanceof Hwp5Document ? validateHwp5(doc) : validateHwpx(doc);
}

function validateHwp5(doc) {
  const problems = [];
  const where = (s, i) => `${s.path} paragraph ${i}`;
  for (const s of doc.sections) {
    try {
      const again = parseRecords(s.serialize());
      if (again.length !== s.records.length) problems.push(`${s.path}: record count changed on re-reading`);
    } catch (e) {
      problems.push(`${s.path}: ${e.message}`);
    }
  }
  const styles = doc.styles;
  problems.push(...styles.check());
  const shapeCount = styles.charShapes.length;
  let i = 0;
  for (const { paragraph: p } of doc.walk()) {
    const at = where(p.section, i++);
    const cu = p.codeUnits();
    if (p.nChars !== cu.length) problems.push(`${at}: length ${p.nChars} but ${cu.length} code units`);
    if (cu[cu.length - 1] !== PARA_END) problems.push(`${at}: does not end with a paragraph end`);
    if (p.textRec && cu.length === 1) problems.push(`${at}: text record holding only the paragraph end`);
    if (controlMaskOf(cu) !== p.controlMask) problems.push(`${at}: control mask out of date`);
    const shapes = p.charShapes();
    if (shapes.length !== p.charShapeCount) problems.push(`${at}: char shape count`);
    if (shapes.length && shapes[0].pos !== 0) problems.push(`${at}: first char shape not at 0`);
    if (!increasing(shapes.map((x) => x.pos), cu.length)) problems.push(`${at}: char shape positions`);
    if (shapes.some((x) => x.id >= shapeCount)) problems.push(`${at}: char shape id past the ${shapeCount} in DocInfo`);
    if (!p.lineSegRec && p.lineSegCount !== 0) problems.push(`${at}: line segment count without line segments`);
    if (p.lineSegRec) {
      const segs = p.lineSegs();
      if (segs.length !== p.lineSegCount) problems.push(`${at}: line segment count`);
      if (!nonDecreasing(segs.map((x) => x.pos), cu.length)) problems.push(`${at}: line segment positions`);
    }
    if (p.rangeTagRec && p.rangeTags().length !== p.rangeTagCount) problems.push(`${at}: range tag count`);
    try {
      const ext = p.units().filter((u) => u.type === 'control' && u.kind === 'extended').length;
      if (ext !== p.controls.length) problems.push(`${at}: ${ext} control chars for ${p.controls.length} controls`);
    } catch (e) {
      problems.push(`${at}: ${e.message}`);
    }
  }
  return problems;
}

function validateHwpx(doc) {
  const problems = [];
  for (const s of doc.sections) {
    try {
      const fresh = parseXml(s.serialize());
      if (!sameShape(fresh, s.xml.root)) problems.push(`${s.path}: XML tree does not match its text`);
    } catch (e) {
      problems.push(`${s.path}: ${e.message}`);
    }
  }
  const styles = doc.styles;
  if (styles.modified) {
    try {
      if (!sameShape(parseXml(styles.serialize()), styles.xml.root)) problems.push('header: XML tree does not match its text');
    } catch (e) {
      problems.push(`header: ${e.message}`);
    }
  }
  problems.push(...styles.check());
  const charPrs = new Set([...styles.xml.root.descendants('charPr')].map((e) => e.attr('id')));
  let i = 0;
  for (const { paragraph: p } of doc.walk()) {
    const at = `${p.section.path} paragraph ${i++}`;
    const segs = p.lineSegs().map((x) => Number(x.attr('textpos')));
    if (!nonDecreasing(segs, p.length)) problems.push(`${at}: lineseg textpos`);
    if (charPrs.size && p.el.all('run').some((r) => r.attr('charPrIDRef') !== undefined && !charPrs.has(r.attr('charPrIDRef')))) problems.push(`${at}: run refers to a missing charPr`);
  }
  return problems;
}

function increasing(list, limit) {
  return list.every((x, i) => x < limit && (i === 0 || x > list[i - 1]));
}

/** Line segments: a line may have several segments at one position, and one may start at the end. */
function nonDecreasing(list, limit) {
  return list.every((x, i) => x <= limit && (i === 0 || x >= list[i - 1]));
}

/** Same element names and offsets in both trees. */
function sameShape(a, b) {
  if (a.type !== b.type || a.start !== b.start || a.end !== b.end) return false;
  if (a.type !== 'element') return true;
  if (a.name !== b.name || a.children.length !== b.children.length) return false;
  return a.children.every((c, i) => sameShape(c, b.children[i]));
}
