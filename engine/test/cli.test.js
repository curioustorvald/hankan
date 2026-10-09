import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDocument, findSlots, ATTRIBUTION } from '../src/index.js';
import { corpusFiles } from './corpus.js';

const CLI = fileURLToPath(new URL('../../cli/hankan.js', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('--help shows the attribution verbatim', () => {
  const r = run('--help');
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes(ATTRIBUTION));
});

test('fills one form once per CSV row; --list reads a directory', () => {
  const form = corpusFiles('hwp5').find((p) => p.endsWith('/0085.hwp'));
  if (!form) return;
  const dir = mkdtempSync(join(tmpdir(), 'hankan-'));
  const csv = join(dir, 'people.csv');
  writeFileSync(csv, '﻿이름,휴대폰\n홍길동,010-1111-2222\n"김, 영희","010-3333-4444"\n');
  const out = join(dir, 'out');
  const r = run(form, csv, '-o', out, '--set', '자격증=정보처리기사');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(readdirSync(out).sort(), ['0085-1.hwp', '0085-2.hwp']);
  const values = (name) => new Map(findSlots(openDocument(new Uint8Array(readFileSync(join(out, name))))).map((s) => [s.key, s.value]));
  // Filled cells are no longer blanks; what is left must not include them.
  const left = values('0085-2.hwp');
  assert.ok(!left.has('성명.한글') && !left.has('연락처.휴대폰') && !left.has('자격증'));

  const lst = run('--list', '--json', out);
  assert.equal(lst.status, 0);
  assert.equal(JSON.parse(lst.stdout).length, 2);
});

test('bad arguments exit with status 2', () => {
  assert.equal(run('nonexistent.hwp', 'x.csv').status, 2);
  assert.equal(run('--frobnicate').status, 2);
});
