import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDocument, validate, Hwp5Document } from '../src/index.js';
import { bytesEqual } from '../src/util/bytes.js';
import { corpusFiles, load } from './corpus.js';

const SAMPLES = ['홍길동', '', 'A&B <C> "q"', '서울특별시 중구\n세종대로 110', '  ', '𝄞 x', '탭\t문자', '010-1234-5678'];

function rng(seed) {
  let x = seed >>> 0 || 1;
  return (n) => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) % n; };
}

/** Text of the units before `start` and from `end` on, around `insert`. */
function expectedText(p, start, end, insert) {
  let before = '', after = '';
  for (const u of p.units()) {
    if (u.type === 'text') {
      // A text unit has one character per position.
      before += u.text.slice(0, Math.max(0, start - u.pos));
      after += u.text.slice(Math.max(0, end - u.pos));
    } else if (u.type === 'control' && u.code === 9) {
      if (u.end <= start) before += '\t';
      else if (u.pos >= end) after += '\t';
    }
  }
  return before + insert.replace(/\r\n?/g, '\n').replace(/\t/g, ' ') + after;
}

/** A random editable range: inside a run of text units, or an insertion before any unit. */
function pickRange(p, rand) {
  const units = p.units();
  const runs = [];
  let cur = null;
  for (const u of units) {
    if (u.type === 'text') {
      if (cur && cur.end === u.pos) cur.end = u.end;
      else { cur = { start: u.pos, end: u.end }; runs.push(cur); }
    } else cur = null;
  }
  // Never pick a position between the halves of a surrogate pair.
  const lowAt = (pos) => units.some((u) => u.type === 'text' && pos >= u.pos && pos < u.end && (u.text.charCodeAt(pos - u.pos) & 0xfc00) === 0xdc00);
  if (runs.length && rand(3)) {
    const r = runs[rand(runs.length)];
    let a = r.start + rand(r.end - r.start + 1);
    let b = a + rand(r.end - a + 1);
    if (lowAt(a)) a--;
    if (lowAt(b)) b++;
    return [a, Math.max(a, b)];
  }
  let { pos } = units[rand(units.length)];
  if (lowAt(pos)) pos--;
  return [pos, pos];
}

function otherParts(doc) {
  if (doc instanceof Hwp5Document) {
    const sections = new Set(doc.sections.map((s) => s.path));
    return doc.cfb.list().filter((e) => e.type === 'stream' && !sections.has(e.path)).map((e) => [e.path, doc.cfb.read(e.path)]);
  }
  const sections = new Set(doc.sections.map((s) => s.path));
  return doc.zip.list().filter((e) => !sections.has(e.name)).map((e) => [e.name, doc.zip.read(e.name)]);
}

async function exercise(path, seed) {
  const doc = openDocument(load(path));
  const rand = rng(seed);
  const paragraphs = [...doc.walk()].map((w) => w.paragraph);
  const expected = paragraphs.map((p) => p.text);
  const edits = Math.min(12, paragraphs.length);
  for (let i = 0; i < edits; i++) {
    const k = rand(paragraphs.length);
    const p = paragraphs[k];
    const [a, b] = pickRange(p, rand);
    const text = SAMPLES[rand(SAMPLES.length)];
    expected[k] = expectedText(p, a, b, text);
    p.replaceRange(a, b, text, { lineSegs: rand(2) ? 'keep' : 'drop' });
    assert.equal(p.text, expected[k], `${path}: paragraph ${k} after edit`);
  }
  assert.deepEqual(validate(doc), [], path);
  const before = otherParts(doc);
  const out = await doc.toBytes();
  const again = openDocument(out);
  const texts = [...again.walk()].map((w) => w.paragraph.text);
  assert.deepEqual(texts, expected, path);
  assert.deepEqual(validate(again), [], path);
  for (const [name, data] of otherParts(again)) {
    const orig = before.find(([n]) => n === name);
    assert.ok(orig && bytesEqual(orig[1], data), `${path}: ${name} changed`);
  }
}

test('random text edits survive a save in HWP 5.0 documents', async () => {
  const files = corpusFiles('hwp5', { stride: Number(process.env.EDIT_STRIDE ?? 23) });
  let seed = 1;
  for (const path of files) {
    try { await exercise(path, seed++); } catch (e) { if (e.name === 'UnsupportedError') continue; throw e; }
  }
});

test('random text edits survive a save in HWPX documents', async () => {
  const files = corpusFiles('hwpx', { stride: Number(process.env.EDIT_STRIDE ?? 3) });
  let seed = 1000;
  for (const path of files) await exercise(path, seed++);
});

test('re-encoding unchanged sections keeps the content', async () => {
  for (const path of [...corpusFiles('hwp5', { stride: 101 }), ...corpusFiles('hwpx', { stride: 29 })]) {
    let doc;
    try { doc = openDocument(load(path)); } catch (e) { if (e.name === 'UnsupportedError') continue; throw e; }
    const texts = [...doc.walk()].map((w) => w.paragraph.text);
    const before = otherParts(doc);
    const again = openDocument(await doc.toBytes({ rewriteAll: true }));
    assert.deepEqual([...again.walk()].map((w) => w.paragraph.text), texts, path);
    for (const s of again.sections) {
      const orig = doc.sections.find((x) => x.path === s.path);
      assert.equal(s.serialize().length, orig.serialize().length, `${path} ${s.path}`);
    }
    for (const [name, data] of otherParts(again)) assert.ok(bytesEqual(before.find(([n]) => n === name)[1], data), `${path}: ${name}`);
  }
});
