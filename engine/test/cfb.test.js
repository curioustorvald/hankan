import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompoundFile } from '../src/container/cfb.js';
import { corpusFiles, load } from './corpus.js';

function pattern(n, seed) {
  const b = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 0xff; }
  return b;
}

const SIZES = [0, 1, 63, 64, 65, 4095, 4096, 4097, 20000, 300000];

test('unmodified compound files are written back byte for byte', () => {
  for (const path of corpusFiles('hwp5', { stride: 50 })) {
    const bytes = load(path);
    assert.deepEqual(new CompoundFile(bytes).toBytes(), bytes, path);
  }
});

test('replacing streams keeps every other stream and the tree intact', () => {
  const files = corpusFiles('hwp5', { stride: 97 });
  let k = 0;
  for (const path of files) {
    const cf = new CompoundFile(load(path));
    const streams = cf.list().filter((e) => e.type === 'stream');
    const before = new Map(streams.map((e) => [e.path, cf.read(e.path)]));
    // Replace up to three streams with sizes that cross the mini-stream cutoff.
    const expected = new Map(before);
    for (let i = 0; i < Math.min(3, streams.length); i++) {
      const target = streams[(k + i * 7) % streams.length].path;
      const data = pattern(SIZES[(k + i) % SIZES.length], k * 31 + i);
      cf.write(target, data);
      expected.set(target, data);
    }
    k++;
    const out = cf.toBytes();
    const again = new CompoundFile(out);
    assert.deepEqual(again.list().map((e) => e.path), cf.list().map((e) => e.path), path);
    for (const [p, data] of expected) assert.deepEqual(again.read(p), data, `${path} ${p}`);
  }
});

test('repeated rewrites converge and never lose data', () => {
  const [path] = corpusFiles('hwp5', { limit: 1 });
  if (!path) return;
  let bytes = load(path);
  const target = 'BodyText/Section0';
  for (const size of [...SIZES, ...SIZES.slice().reverse(), 1_200_000, 10]) {
    const cf = new CompoundFile(bytes);
    const data = pattern(size, size + 1);
    const others = cf.list().filter((e) => e.type === 'stream' && e.path !== target).map((e) => [e.path, cf.read(e.path)]);
    cf.write(target, data);
    bytes = cf.toBytes();
    const again = new CompoundFile(bytes);
    assert.deepEqual(again.read(target), data);
    for (const [p, d] of others) assert.deepEqual(again.read(p), d, p);
  }
});
