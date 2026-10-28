import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDocument, findSlots, documentOutline } from '../src/index.js';
import { borderFill } from '../src/hwp5/docinfo.js';
import { corpusFiles, load } from './corpus.js';

const tables = (doc) => documentOutline(doc, findSlots(doc)).filter((b) => b.type === 'table');
const cellAt = (t, row, col) => t.cells.find((c) => c.row === row && c.col === col);

test('an HWP 5.0 border/fill record: sides of 6 bytes, then the diagonal and the fill (C12)', () => {
  const d = new Uint8Array(53);
  const v = new DataView(d.buffer);
  v.setUint16(0, 0b010_010_00, true); // slash and back-slash (표 24 bits 2–7)
  const side = (k, type, width, colour) => { d[2 + 6 * k] = type; d[3 + 6 * k] = width; v.setUint32(4 + 6 * k, colour, true); };
  side(0, 0, 1, 0); // left: none
  side(1, 1, 6, 0x0000ff); // right: solid 0.4 mm, red (COLORREF 0x00bbggrr)
  side(2, 8, 1, 0); // top: double
  side(3, 3, 9, 0xc0b2b2b2); // bottom: dashed 0.7 mm; the top byte is not part of a line's colour
  side(4, 1, 0, 0); // diagonal
  v.setUint32(32, 1, true); // solid fill
  v.setUint32(36, 0xdadada, true);
  const b = borderFill(d);
  assert.equal(b.left, null);
  assert.deepEqual(b.right, { type: 'SOLID', width: 0.4, color: '#ff0000' });
  assert.equal(b.top.type, 'DOUBLE_SLIM');
  assert.deepEqual(b.bottom, { type: 'DASH', width: 0.7, color: '#b2b2b2' });
  assert.ok(b.slash && b.backSlash);
  assert.equal(b.fill, '#dadada');
  v.setUint32(36, 0xffffffff, true);
  assert.equal(borderFill(d).fill, null);
});

test('the outline keeps an OWPML form\'s cell borders (0008: headings between rules, no outer sides)', () => {
  const path = corpusFiles('hwpx').find((p) => p.endsWith('/0008.hwpx'));
  if (!path) return;
  const [t] = tables(openDocument(load(path)));
  // "1. 신청자 인적사항" and the date beside it: thick rules above and below, no line between them.
  const head = cellAt(t, 1, 0);
  assert.equal(head.border.top.width, 0.4);
  assert.equal(head.border.bottom.width, 0.4);
  assert.equal(head.border.right, null);
  assert.equal(cellAt(t, 1, 8).border.left, null);
  // The gap row before part 2 has no sides.
  const gap = cellAt(t, 5, 0);
  assert.equal(gap.border.left, null);
  assert.equal(gap.border.right, null);
  // Inner lines are light grey.
  assert.equal(cellAt(t, 3, 2).border.left.color, '#cccccc');
});

test('the outline keeps an HWP 5.0 form\'s fills and diagonals (0109)', () => {
  const path = corpusFiles('hwp5').find((p) => p.endsWith('/0109.hwp'));
  if (!path) return;
  const t = tables(openDocument(load(path))).find((x) => x.rows === 5 && x.cols === 4);
  assert.equal(cellAt(t, 0, 0).border.fill, '#dadada');
  assert.equal(cellAt(t, 0, 0).border.left, null);
  const crossed = cellAt(t, 1, 3).border;
  assert.ok(crossed.slash && crossed.backSlash);
  // The rule above "계" is 0.4 mm.
  assert.equal(cellAt(t, 4, 0).border.top.width, 0.4);
});

const cellIds = (path) => {
  const doc = openDocument(load(path));
  return new Set(findSlots(doc).filter((s) => s.kind === 'cell').map((s) => s.id));
};

test('gap rows between parts of a form are not blanks (0008)', () => {
  const path = corpusFiles('hwpx').find((p) => p.endsWith('/0008.hwpx'));
  if (!path) return;
  const ids = cellIds(path);
  // The rule row on top, the gap before part 2, the two rule rows at the foot.
  for (const id of ['t0.r0c0', 't0.r0c8', 't0.r5c0', 't0.r17c0', 't0.r18c0']) assert.ok(!ids.has(id), id);
  for (const id of ['t0.r2c2', 't0.r4c2', 't0.r8c1', 't0.r16c9']) assert.ok(ids.has(id), id);
});

test('crossed-out cells are not blanks (0109)', () => {
  const path = corpusFiles('hwp5').find((p) => p.endsWith('/0109.hwp'));
  if (!path) return;
  const ids = cellIds(path);
  for (const id of ['t2.r1c3', 't2.r2c3', 't2.r3c3']) assert.ok(!ids.has(id), id);
  for (const id of ['t2.r1c1', 't2.r1c2']) assert.ok(ids.has(id), id);
});

test('ruled lines in a table without side lines stay blanks (0378)', () => {
  const path = corpusFiles('hwp5').find((p) => p.endsWith('/0378.hwp'));
  if (!path) return;
  const ids = cellIds(path);
  for (let r = 1; r <= 6; r++) assert.ok(ids.has(`t3.r${r}c0`), `t3.r${r}c0`);
});
