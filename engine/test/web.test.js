import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDocument, findSlots, documentOutline, planFill, createZip } from '../src/index.js';
import { ZipArchive } from '../src/container/zip.js';
import { corpusFiles, load } from './corpus.js';

test('the outline shows every slot exactly where the document has it', () => {
  for (const path of [...corpusFiles('hwp5', { stride: 97 }), ...corpusFiles('hwpx', { stride: 19 })]) {
    let doc;
    try { doc = openDocument(load(path)); } catch (e) { if (e.name === 'UnsupportedError') continue; throw e; }
    const slots = findSlots(doc);
    const outline = documentOutline(doc, slots);
    const seen = new Map();
    const visit = (blocks) => {
      for (const b of blocks) {
        if (b.type === 'p') for (const s of b.segments) if (s.slot) seen.set(`${s.slot}/${s.option ?? ''}`, (seen.get(`${s.slot}/${s.option ?? ''}`) ?? 0) + 1);
        if (b.type === 'table') for (const c of b.cells) { if (c.slot) seen.set(`${c.slot}/`, (seen.get(`${c.slot}/`) ?? 0) + 1); visit(c.blocks); }
      }
    };
    visit(outline);
    for (const s of slots) {
      const keys = s.kind === 'choice' ? s.options.map((_, i) => `${s.id}/${i}`) : [`${s.id}/`];
      for (const k of keys) assert.equal(seen.get(k), 1, `${path}: ${k} shown ${seen.get(k) ?? 0} times`);
    }
  }
});

test('planFill matches without changing the document', () => {
  const path = corpusFiles('hwp5').find((p) => p.endsWith('/0085.hwp'));
  if (!path) return;
  const doc = openDocument(load(path));
  const slots = findSlots(doc);
  const before = [...doc.walk()].map((w) => w.paragraph.text).join('\n');
  const { plan } = planFill(slots, { 이름: '홍길동', 휴대폰: '010-1234-5678' });
  assert.deepEqual([...plan.keys()].map((s) => s.key).sort(), ['성명', '성명.한글', '연락처.휴대폰']);
  assert.equal([...doc.walk()].map((w) => w.paragraph.text).join('\n'), before);
});

test('createZip writes an archive that reads back', async () => {
  const files = [{ name: '양식-1.hwp', data: new Uint8Array([1, 2, 3]) }, { name: 'b.txt', data: new TextEncoder().encode('가'.repeat(500)) }];
  const zip = new ZipArchive(await createZip(files));
  assert.deepEqual(zip.list().map((e) => e.name), ['양식-1.hwp', 'b.txt']);
  for (const f of files) assert.deepEqual(zip.read(f.name), f.data);
});
