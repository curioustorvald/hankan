// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Which text colours mark text out. Forms often print placeholders and
// notes in red (or another colour); text written over them should come out
// in ordinary black. Near-black is ordinary text; near-white is text on a
// dark background, which black would hide. Generic; no format knowledge.

/** @param {string|null|undefined} hex '#rrggbb' */
export function isColoured(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  if (!m) return false;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
  return Math.max(r, g, b) > 0x40 && Math.min(r, g, b) < 0xd0;
}

/**
 * Turn coloured text in [start, end) of a paragraph black, by giving it
 * black copies of its character shapes (doc.blackShape). Text in ordinary
 * colours is left alone.
 * @returns {boolean} whether anything changed
 */
export function recolour(doc, paragraph, start, end) {
  if (start >= end || !doc.blackShape) return false;
  const shapes = doc.styles.charShapes;
  const black = new Map();
  for (const id of paragraph.charShapeIdsIn(start, end)) {
    if (isColoured(shapes[id]?.color)) black.set(id, doc.blackShape(id));
  }
  if (!black.size) return false;
  // Only the colour changes, so the paragraph's layout cache stays valid.
  return paragraph.restyle(start, end, (id) => black.get(id) ?? id, { lineSegs: 'keep' });
}
