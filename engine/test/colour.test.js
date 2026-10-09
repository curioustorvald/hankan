import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDocument, findSlots, documentOutline, fillForm, paragraphList } from '../src/index.js';
import { isColoured } from '../src/form/colour.js';
import { CompoundFile } from '../src/container/cfb.js';
import { ZipArchive } from '../src/container/zip.js';
import { corpusFiles, load } from './corpus.js';

function segments(doc) {
  const out = [];
  const visit = (blocks) => {
    for (const b of blocks) {
      if (b.type === 'p') for (const s of b.segments) if (s.p !== undefined) out.push(s);
      if (b.type === 'table') for (const c of b.cells) visit(c.blocks);
    }
  };
  visit(documentOutline(doc, findSlots(doc)));
  return out;
}

const edit = (s, to) => ({ p: s.p, start: s.start, end: s.end, from: s.text, to });
const colourAt = (doc, p, pos) => doc.charStyleAt(paragraphList(doc)[p], pos)?.color;
const shapeCount = (doc) => doc.styles.charShapes.filter(Boolean).length;
/** Text of [start, end) by position (controls count 8 and are left out). */
const textAt = (doc, p, start, end) => paragraphList(doc)[p].units()
  .filter((u) => u.type === 'text' && u.end > start && u.pos < end)
  .map((u) => u.text.slice(Math.max(0, start - u.pos), end - u.pos)).join('');

test('which colours count as coloured', () => {
  for (const c of ['#ff0000', '#0000ff', '#7f7f7f', '#ff6600', '#4c4c4c']) assert.ok(isColoured(c), c);
  for (const c of ['#000000', '#202020', '#ffffff', '#e0e0e0', null, 'none']) assert.ok(!isColoured(c), c);
});

test('the outline gives coloured text its colour', () => {
  const path = corpusFiles('hwp5').find((p) => p.endsWith('/0037.hwp'));
  if (!path) return;
  const segs = segments(openDocument(load(path)));
  const red = segs.filter((s) => s.color && s.text.includes('간이'));
  assert.ok(red.length > 0);
  assert.ok(red.every((s) => isColoured(s.color)));
  assert.ok(segs.some((s) => !s.color && s.text.includes('회생')));
});

test('edited red text turns black; other red text stays red', async () => {
  const path = corpusFiles('hwp5').find((p) => p.endsWith('/0037.hwp'));
  if (!path) return;
  const bytes = load(path);
  const doc = openDocument(bytes);
  const red = segments(doc).filter((s) => s.color && s.text === '(간이)');
  const shapeOf = (s) => paragraphList(doc)[s.p].charShapeIdAt(s.start);
  const a = red[0];
  const b = red.find((s) => s !== a && shapeOf(s) === shapeOf(a));
  assert.ok(a && b, 'two red "(간이)" in one character shape');
  const { bytes: out, report } = await fillForm(bytes, {}, { edits: [edit(a, '(일반)')] });
  assert.deepEqual(report.edits.failed, []);
  const after = openDocument(out);
  assert.equal(textAt(after, a.p, a.start, a.end), '(일반)');
  for (let i = a.start; i < a.end; i++) assert.equal(colourAt(after, a.p, i), '#000000', `position ${i}`);
  assert.ok(isColoured(colourAt(after, b.p, b.start)), 'the other "(간이)" is still red');
  if (a.start > 0) assert.equal(colourAt(after, a.p, a.start - 1), colourAt(doc, a.p, a.start - 1), 'text before keeps its colour');
  assert.ok(shapeCount(after) - shapeCount(doc) <= 1);
  // A second edit of the same red reuses the black shape made for the first.
  const both = await fillForm(bytes, {}, { edits: [edit(a, '(일반)'), edit(b, '(보통)')] });
  assert.equal(shapeCount(openDocument(both.bytes)), shapeCount(after));
});

test('edits of black text leave the style table alone', async () => {
  const path = corpusFiles('hwp5').find((p) => p.endsWith('/0037.hwp'));
  if (!path) return;
  const bytes = load(path);
  const s = segments(openDocument(bytes)).find((x) => !x.color && x.text.includes('OOO'));
  const { bytes: out } = await fillForm(bytes, {}, { edits: [edit(s, s.text.replace('OOO', '홍길동'))] });
  assert.deepEqual(new CompoundFile(out).read('DocInfo'), new CompoundFile(bytes).read('DocInfo'));
});

test('HWPX: a coloured stretch inside a longer run is split off and turns black', async () => {
  let done = 0;
  for (const path of corpusFiles('hwpx')) {
    let doc;
    try { doc = openDocument(load(path)); } catch { continue; }
    const s = segments(doc).find((x) => x.color && x.text.trim().length >= 2);
    if (!s) continue;
    const bytes = load(path);
    const to = `${s.text}*`;
    const { bytes: out, report } = await fillForm(bytes, {}, { edits: [edit(s, to)] });
    assert.deepEqual(report.edits.failed, [], path);
    const after = openDocument(out);
    const p = paragraphList(after)[s.p];
    assert.equal(textAt(after, s.p, s.start, s.start + to.length), to, path);
    for (let i = s.start; i < s.start + to.length; i++) assert.equal(colourAt(after, s.p, i), '#000000', `${path} ${i}`);
    const end = s.start + to.length;
    if (end < p.length - 1 && p.units().find((u) => u.pos === end)?.type === 'text') {
      assert.equal(colourAt(after, s.p, end), colourAt(doc, s.p, s.end), `${path}: text after keeps its colour`);
    }
    // Only the section and the header change.
    const zin = new ZipArchive(bytes);
    const zout = new ZipArchive(out);
    const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    const changed = zin.list().map((e) => e.name).filter((n) => !same(zin.read(n), zout.read(n)));
    assert.ok(changed.every((n) => /^Contents\/(section\d+|header)\.xml$/.test(n)), `${path}: ${changed}`);
    if (++done >= 6) break;
  }
  assert.ok(done > 0, 'no coloured HWPX text found');
});

test('a filled cell that held coloured text comes out black', async () => {
  let done = 0;
  for (const path of corpusFiles('hwp5', { stride: 3 })) {
    let doc;
    try { doc = openDocument(load(path)); } catch { continue; }
    const slot = findSlots(doc).find((s) => {
      if (s.kind !== 'cell') return false;
      const r = s._range();
      return isColoured(doc.charStyleAt(r.paragraph, r.start)?.color);
    });
    if (!slot) continue;
    const { paragraph, start } = slot._range();
    const p = paragraphList(doc).indexOf(paragraph);
    const { bytes: out, report } = await fillForm(load(path), { [slot.id]: '홍길동' });
    assert.equal(report.filled.length, 1, path);
    const after = openDocument(out);
    assert.equal(textAt(after, p, start, start + 3), '홍길동', path);
    for (let i = start; i < start + 3; i++) assert.equal(colourAt(after, p, i), '#000000', `${path} ${i}`);
    if (++done >= 3) break;
  }
  assert.ok(done > 0);
});

test('editing coloured text across the corpus keeps documents valid and turns it black', async () => {
  const stride = Number(process.env.EDIT_STRIDE ?? 23);
  let edited = 0;
  for (const path of [...corpusFiles('hwp5', { stride }), ...corpusFiles('hwpx', { stride: Math.ceil(stride / 5) })]) {
    let doc;
    try { doc = openDocument(load(path)); } catch (e) { if (e.name === 'UnsupportedError') continue; throw e; }
    const coloured = segments(doc).filter((s) => s.color && s.text.trim() && !s.text.includes('\ufffd'));
    if (!coloured.length) continue;
    const picks = [...new Set([coloured[0], coloured[Math.floor(coloured.length / 2)], coloured[coloured.length - 1]])];
    const edits = picks.map((s, i) => edit(s, i === 1 ? '값' : `${s.text}값`));
    const { bytes: out, report } = await fillForm(load(path), {}, { edits }); // throws on a damaged output
    assert.deepEqual(report.edits.failed, [], path);
    assert.deepEqual(report.edits.warnings, [], path);
    const after = openDocument(out);
    // Edits are applied in order, so a later edit in the same paragraph moves an earlier one; check the last.
    const last = edits[edits.length - 1];
    const lastFrom = picks[picks.length - 1];
    if (picks.every((s) => s === lastFrom || s.p !== lastFrom.p || s.start > lastFrom.start)) {
      for (let i = lastFrom.start; i < lastFrom.start + last.to.length; i++) assert.equal(colourAt(after, lastFrom.p, i), '#000000', `${path} ${i}`);
    }
    edited += edits.length;
  }
  assert.ok(edited > 0);
});
