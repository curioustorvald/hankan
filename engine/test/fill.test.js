import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDocument, findSlots, fillSlots, fillForm, fieldSpans, validate, SlotMatcher } from '../src/index.js';
import { HwpxSection } from '../src/hwpx/section.js';
import { corpusFiles, load } from './corpus.js';

/** Current text of every slot, looked up on a freshly opened document by slot id. */
function readBack(doc) {
  const tables = [];
  const fields = [];
  for (const { paragraph } of doc.walk()) {
    for (const c of paragraph.controls) if (c.cells) tables.push(c);
  }
  return {
    cell(id) {
      const m = /^t(\d+)\.r(\d+)c(\d+)$/.exec(id);
      const cell = tables[+m[1]].cells.find((c) => c.row === +m[2] && c.col === +m[3]);
      return cell.paragraphs.map((p) => p.text).join('\n');
    },
  };
}

test('filling every slot and reading it back after a save', async () => {
  const k = process.env.FILL_STRIDE;
  const files = [...corpusFiles('hwp5', { stride: Number(k ?? 31) }), ...corpusFiles('hwpx', { stride: Number(k ?? 5) })];
  let checked = 0;
  for (const path of files) {
    let doc;
    try { doc = openDocument(load(path)); } catch (e) { if (e.name === 'UnsupportedError') continue; throw e; }
    const slots = findSlots(doc);
    if (!slots.length) continue;
    // A year that continues whatever the form prints before it ("20", "19", "201").
    const prefix = (s) => s._blank?.parts.find((p) => p.role === 'year')?.prefix ?? '';
    const year = (s) => prefix(s) + '2026'.slice(prefix(s).length);
    const valueFor = (s, i) => (s.kind === 'choice' ? s.options.find((o, k) => !s._options[k].checked) ?? s.options[0] : s.blank === 'date' ? `${year(s)}-10-09` : s.blank === 'split' ? ['900101', '1234567', '89'].slice(0, s._blank.parts.length).join('-')
      : s.kind === 'blank' ? `값 ${i} <&>` : i % 3 ? `값 ${i}` : `여러 줄\n값 ${i} <&>`);
    const record = Object.fromEntries(slots.map((s, i) => [s.id, valueFor(s, i)]));
    // Checked boxes: filled box characters, and brackets with a mark inside.
    const marked = /[■☑▣◼]|[[［(（][ \u3000]*[√∨✓✔ｖvVＶ○◯OＯ][ \u3000]*[\]］)）]/g;
    const filledBoxes = (d) => [...d.walk()].reduce((n, w) => n + (w.paragraph.text.match(marked)?.length ?? 0)
      + w.paragraph.controls.filter((c) => c.formType && c.checked).length, 0); // and checked form objects
    const boxesBefore = filledBoxes(doc);
    const newlyChecked = slots.filter((s) => s.kind === 'choice' && !s._options.find((o) => o.label === record[s.id])?.checked).length;
    const report = fillSlots(slots, record);
    assert.equal(report.filled.length, slots.length, `${path}: ${JSON.stringify(report.ambiguous.slice(0, 3))}`);
    assert.deepEqual(validate(doc), [], path);

    const again = openDocument(await doc.toBytes());
    assert.deepEqual(validate(again), [], path);
    const look = readBack(again);
    const refound = new Map(findSlots(again).map((s) => [s.id, s]));
    const paragraphs = [...again.walk()].map((w) => w.paragraph);
    assert.equal(filledBoxes(again), boxesBefore + newlyChecked, `${path}: checked boxes`);
    for (const s of slots) {
      const want = record[s.id];
      if (s.kind === 'choice') { checked++; continue; }
      if (s.kind === 'blank') {
        // Every part's value appears in the paragraph, in order.
        const text = paragraphs[+/^p(\d+)/.exec(s.id)[1]].text;
        const date = { year: year(s).slice(prefix(s).length), month: '10', day: '9' };
        const parts = s.blank === 'date' ? s._blank.parts.map((p) => date[p.role]) : s.blank === 'split' ? want.split('-') : [want];
        let from = 0;
        for (const part of parts) {
          const at = text.indexOf(part, from);
          assert.ok(at >= 0, `${path} ${s.id}: ${JSON.stringify(part)} not in ${JSON.stringify(text)}`);
          from = at + 1;
        }
        checked++;
        continue;
      }
      if (s.kind === 'cell') assert.equal(look.cell(s.id).split('\n')[0] + (want.includes('\n') ? '\n' + look.cell(s.id).split('\n')[1] : ''), want, `${path} ${s.id}`);
      else assert.equal(refound.get(s.id)?.value, want, `${path} ${s.id}`);
      checked++;
    }
  }
  assert.ok(checked > 1000, `only ${checked} slots checked`);
});

test('columns are matched by label, alias and key', async () => {
  const [path] = corpusFiles('hwp5').filter((p) => p.endsWith('/0085.hwp'));
  if (!path) return;
  const doc = openDocument(load(path));
  const slots = findSlots(doc);
  const report = fillSlots(slots, { 이름: '홍길동', '성명(영문)': 'HONG Gildong', 휴대폰: '010-0000-0000', '자격증#2': '정보처리기사', '석사.전공': '전산학', 없는칸: 'x' });
  const byKey = new Map(report.filled.map((f) => [f.slot, f.column]));
  assert.equal(byKey.get('성명.한글'), '이름');
  assert.equal(byKey.get('성명'), '이름'); // the signature line asks for the name again
  assert.equal(byKey.get('성명.영문'), '성명(영문)');
  assert.equal(byKey.get('연락처.휴대폰'), '휴대폰');
  assert.equal(byKey.get('자격증#2'), '자격증#2');
  assert.equal(byKey.get('석사.전공'), '석사.전공');
  assert.deepEqual(report.unmatched, ['없는칸']);
});

test('a filled click-here field takes the field\'s character shape, not the guide text\'s', async () => {
  const path = corpusFiles('hwp5').find((p) => p.endsWith('/0057.hwp'));
  if (!path) return;
  const { bytes } = await fillForm(load(path), Object.fromEntries(findSlots(openDocument(load(path))).filter((s) => s.kind === 'field').map((s) => [s.id, '값'])));
  let checked = 0;
  for (const { paragraph } of openDocument(bytes).walk()) {
    for (const s of fieldSpans(paragraph)) {
      const shapes = paragraph.charShapes();
      const at = (pos) => shapes.filter((x) => x.pos <= pos).pop()?.id;
      assert.equal(at(s.begin.end), at(s.begin.pos));
      assert.equal(at(s.end.pos), at(s.begin.pos));
      assert.ok(shapes.every((x, i) => i === 0 || x.id !== shapes[i - 1].id), 'no repeated shape runs');
      checked++;
    }
  }
  assert.equal(checked, 2);
});

test('in OWPML the value goes into the field\'s own run', () => {
  const xml = '<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p id="0"><hp:run charPrIDRef="1"><hp:ctrl><hp:fieldBegin id="7" type="CLICK_HERE" name="" dirty="0"/></hp:ctrl></hp:run>'
    + '<hp:run charPrIDRef="2"><hp:t>안내문</hp:t></hp:run><hp:run charPrIDRef="1"><hp:ctrl><hp:fieldEnd beginIDRef="7"/></hp:ctrl><hp:t>뒤</hp:t></hp:run>'
    + '<hp:linesegarray><hp:lineseg textpos="0"/></hp:linesegarray></hp:p></hs:sec>';
  const section = new HwpxSection('Contents/section0.xml', xml);
  const [p] = section.paragraphs;
  const [span] = fieldSpans(p);
  p.replaceRange(span.begin.end, span.end.pos, '홍길동', { styleOf: span.begin.pos });
  assert.equal(p.text, '홍길동뒤');
  assert.match(section.serialize(), /<hp:run charPrIDRef="1"><hp:ctrl><hp:fieldBegin[^>]*\/><\/hp:ctrl><hp:t>홍길동<\/hp:t><\/hp:run><hp:run charPrIDRef="2"><hp:t\/><\/hp:run>/);
  assert.ok(!section.serialize().includes('linesegarray'), 'layout cache dropped');
});

test('a bare column fills the user\'s slots but not another party\'s', () => {
  const slot = (id, labels, group = null) => ({ id, kind: 'cell', labels, display: labels, index: 1, group, key: labels.join('.'), value: '' });
  const slots = [slot('a', ['신청인', '성명']), slot('b', ['대리인', '성명']), slot('c', ['성명'], '배우자'), slot('d', ['성명'])];
  const m = new SlotMatcher(slots);
  assert.deepEqual(m.match('성명').slots.map((s) => s.id), ['a', 'd']);
  assert.deepEqual(m.match('대리인.성명').slots.map((s) => s.id), ['b']);
  assert.equal(m.match('성명').ambiguous, false);
  const two = new SlotMatcher([slot('x', ['갑', '주소']), slot('y', ['을', '주소'])]);
  assert.equal(two.match('주소').ambiguous, true);
});
