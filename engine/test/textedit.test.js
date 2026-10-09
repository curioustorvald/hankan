import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDocument, findSlots, documentOutline, fillForm, textDiff, paragraphList } from '../src/index.js';
import { corpusFiles, load } from './corpus.js';

const textOf = (bytes) => paragraphList(openDocument(bytes)).map((p) => p.text).join('\n');

/** Every editable text segment of a document's outline, with whether it sits in a table. */
function segments(doc) {
  const out = [];
  const visit = (blocks, inCell) => {
    for (const b of blocks) {
      if (b.type === 'p') for (const s of b.segments) if (s.p !== undefined) out.push({ ...s, inCell });
      if (b.type === 'table') for (const c of b.cells) visit(c.blocks, true);
    }
  };
  visit(documentOutline(doc, findSlots(doc)), false);
  return out;
}

const edit = (s, to) => ({ p: s.p, start: s.start, end: s.end, from: s.text, to });

test('textDiff replaces only the characters that differ', () => {
  assert.deepEqual(textDiff('20OO. OO. OO.', '2026. 10. 09.'), [
    { start: 2, end: 4, text: '26' }, { start: 6, end: 8, text: '10' }, { start: 10, end: 12, text: '09' },
  ]);
  assert.deepEqual(textDiff('채무자의 관리인 OOO은', '채무자의 관리인 홍길동은'), [{ start: 9, end: 12, text: '홍길동' }]);
  assert.deepEqual(textDiff('same', 'same'), []);
  assert.deepEqual(textDiff('', '새 글'), [{ start: 0, end: 0, text: '새 글' }]);
  assert.deepEqual(textDiff('※대량일 경우 뒤쪽 사용', ''), [{ start: 0, end: 13, text: '' }]);
  // Surrogate pairs are never split.
  assert.deepEqual(textDiff('a\u{1F600}b', 'a\u{1F601}b'), [{ start: 1, end: 3, text: '\u{1F601}' }]);
});

test('placeholders in running text are replaced in place', async () => {
  const path = corpusFiles('hwp5').find((p) => p.endsWith('/0037.hwp'));
  if (!path) return;
  const bytes = load(path);
  const segs = segments(openDocument(bytes));
  const s = segs.find((x) => x.text.includes('채무자의 관리인 OOO은'));
  assert.ok(s, 'segment found');
  const to = s.text.replace('OOO은', '홍길동은');
  const { bytes: out, report } = await fillForm(bytes, {}, { edits: [edit(s, to)] });
  assert.equal(report.edits.applied.length, 1);
  assert.deepEqual(report.edits.failed, []);
  const before = textOf(bytes);
  const after = textOf(out);
  assert.ok(after.includes('채무자의 관리인 홍길동은'));
  assert.equal(after, before.replace('채무자의 관리인 OOO은', '채무자의 관리인 홍길동은'));
});

test('an edit that no longer fits is refused and changes nothing', async () => {
  const path = corpusFiles('hwp5').find((p) => p.endsWith('/0037.hwp'));
  if (!path) return;
  const bytes = load(path);
  const s = segments(openDocument(bytes)).find((x) => x.text.length > 3);
  const stale = { ...edit(s, 'x'), from: s.text + '?' };
  const { bytes: out, report } = await fillForm(bytes, {}, { edits: [stale] });
  assert.equal(report.edits.failed.length, 1);
  assert.deepEqual(out, bytes);
});

test('empty cells can be written into, in both formats', async () => {
  for (const kind of ['hwp5', 'hwpx']) {
    let done = false;
    for (const path of corpusFiles(kind, { stride: 7 })) {
      let doc;
      try { doc = openDocument(load(path)); } catch { continue; }
      const s = segments(doc).find((x) => x.inCell && x.text === '');
      if (!s) continue;
      const bytes = load(path);
      const { bytes: out, report } = await fillForm(bytes, {}, { edits: [edit(s, '새 글\n둘째 줄')] });
      assert.deepEqual(report.edits.failed, [], path);
      const p = paragraphList(openDocument(out))[s.p];
      assert.equal(p.text, '새 글\n둘째 줄', path);
      done = true;
      break;
    }
    assert.ok(done, `${kind}: no empty cell found`);
  }
});

test('text edits and slot fills share a paragraph', async () => {
  let checked = 0;
  for (const path of corpusFiles('hwp5', { stride: 5 })) {
    let doc;
    try { doc = openDocument(load(path)); } catch { continue; }
    const slots = findSlots(doc);
    const outline = documentOutline(doc, slots);
    // A paragraph with a blank and editable text after it.
    let pair = null;
    const visit = (blocks) => {
      for (const b of blocks) {
        if (pair) return;
        if (b.type === 'p') {
          const i = b.segments.findIndex((x) => x.slot && slots.find((s) => s.id === x.slot)?.blank === 'text');
          const after = i >= 0 ? b.segments.slice(i + 1).find((x) => x.p !== undefined && x.text.trim()) : null;
          if (after) pair = { slot: b.segments[i].slot, seg: after };
        }
        if (b.type === 'table') for (const c of b.cells) visit(c.blocks);
      }
    };
    visit(outline);
    if (!pair) continue;
    const bytes = load(path);
    const to = `${pair.seg.text}(고침)`;
    const { bytes: out, report } = await fillForm(bytes, { [pair.slot]: '홍길동' }, { edits: [edit(pair.seg, to)] });
    assert.equal(report.filled.length, 1, path);
    assert.deepEqual(report.edits.failed, [], path);
    const p = paragraphList(openDocument(out))[pair.seg.p].text;
    assert.ok(p.includes('홍길동') && p.includes(to), `${path}: ${p}`);
    if (++checked >= 5) break;
  }
  assert.ok(checked > 0);
});

test('editing the corpus keeps every document valid', async () => {
  const stride = Number(process.env.EDIT_STRIDE ?? 41);
  let edited = 0;
  for (const path of [...corpusFiles('hwp5', { stride }), ...corpusFiles('hwpx', { stride: Math.ceil(stride / 5) })]) {
    let doc;
    try { doc = openDocument(load(path)); } catch (e) { if (e.name === 'UnsupportedError') continue; throw e; }
    const segs = segments(doc).filter((s) => !s.text.includes('\ufffd'));
    if (!segs.length) continue;
    // Change the middle of a few stretches, empty one, and add to an empty one.
    const picks = [segs[0], segs[Math.floor(segs.length / 2)], segs[segs.length - 1]];
    const edits = [...new Map(picks.map((s) => [`${s.p}:${s.start}`, s])).values()].map((s, i) => {
      const mid = Math.floor(s.text.length / 2);
      return edit(s, i === 1 ? '' : `${s.text.slice(0, mid)}가나다${s.text.slice(mid)}`);
    });
    const { report } = await fillForm(load(path), {}, { edits }); // throws on a damaged output
    assert.deepEqual(report.edits.failed, [], path);
    edited += edits.length;
  }
  assert.ok(edited > 0);
});
