#!/usr/bin/env node
// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Makes a verification batch for blanks in running text and check boxes,
// after the widths were calibrated (batch 003). Three parts, each checked
// by tools/render/verify.py against the corpus renders:
//
//   A  one blank filled per file, with a value that fits it: the text after
//      the blank must stay where it was (shift under half a space);
//   B  whole forms filled with plausible values, for review by eye: the page
//      count must not change;
//   C  forms with check boxes, every choice set to an option: the only
//      changes must be box-sized marks (batch 004: box characters; 005:
//      bracket boxes);
//   F  (batch 005) the forms with form-object check boxes and radio buttons,
//      every such choice set: the only changes must be box-sized marks. Forms
//      without a corpus render also get an unfilled re-saved copy to compare
//      with.
//
// Usage: node tools/render/make-verification.js [--batch 004] [--out render-batches]

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDocument, findSlots, fillSlots, setSlotValue, validate, UnsupportedError } from '../../engine/src/index.js';
import { paragraphChars } from '../../engine/src/form/inline.js';
import { textWidth } from '../../engine/src/form/width.js';
import { crc32 } from '../../engine/src/util/crc32.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CORPUS = join(ROOT, 'provenance/Corpus');
const { values: opt } = parseArgs({ options: { batch: { type: 'string', default: '004' }, out: { type: 'string', default: join(ROOT, 'render-batches') } } });
const DIR = join(opt.out, opt.batch);
const FILES = join(DIR, 'files');
const rank = (s) => crc32(new TextEncoder().encode(`verification:${s}`));

/** Values tried for part A, in turn, the first that fits winning. */
const FITTING = [['홍길동', '010-1234-5678', '서울특별시 중구', '2026', '김', '7'], ['010-1234-5678', '홍길동', '12345', '김철수', '9', '이']];

/** A plausible value for a slot of part B, by its kind and label. */
function plausible(slot) {
  if (slot.kind === 'choice') return slot.options.find((o, k) => !slot._options[k].checked) ?? null;
  if (slot.blank === 'date') {
    const prefix = slot._blank.parts.find((p) => p.role === 'year')?.prefix ?? '';
    return `${prefix + '2026'.slice(prefix.length)}-10-09`;
  }
  if (slot.blank === 'split') return ['900101', '1234567', '89'].slice(0, slot._blank.parts.length).join('-');
  const l = slot.labels.join(' ');
  if (/성명|이름|신청인|청구인|지원자|작성자|대표자|제출인/.test(l)) return '홍길동';
  if (/주소|소재지|거주지/.test(l)) return '서울특별시 중구 세종대로 110';
  if (/전화|연락처|휴대|팩스/.test(l)) return '010-1234-5678';
  if (/이메일|전자우편/.test(l)) return 'hong@example.com';
  if (/^(원|금액)$|금액/.test(l)) return '1,000,000';
  return '테스트';
}

function documents() {
  const out = [];
  for (const format of ['hwp5', 'hwpx']) {
    const dir = join(CORPUS, format);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => /\.hwpx?$/.test(f)).sort()) {
      const stem = file.replace(/\.[^.]+$/, '');
      const rendered = existsSync(join(dir, `${stem}_p001.jpg`));
      out.push({ format, file, stem, path: join(dir, file), rendered });
    }
  }
  return out;
}

async function write(name, doc) {
  const problems = validate(doc);
  if (problems.length) throw new Error(`${name}: ${problems[0]}`);
  writeFileSync(join(FILES, name), await doc.toBytes());
  return name.replace(/\.[^.]+$/, '');
}

async function main() {
  if (existsSync(FILES) && readdirSync(FILES).some((f) => /\.hwpx?$/.test(f))) throw new Error(`${FILES} already holds documents`);
  mkdirSync(FILES, { recursive: true });
  const used003 = existsSync(join(opt.out, '003', 'manifest.json'))
    ? new Set(JSON.parse(readFileSync(join(opt.out, '003', 'manifest.json'), 'utf8')).blanks.map((b) => b.source)) : new Set();
  const docs = documents();
  const manifest = { batch: opt.batch, kind: 'verification', created: new Date().toISOString(), blanks: [], forms: [] };
  const ext = (d) => (d.format === 'hwpx' ? 'hwpx' : 'hwp');
  const tag = (d) => `${d.format}-${d.stem}`;

  // Part A: candidates as for calibration, from forms batch 003 did not use.
  const cands = [];
  for (const d of docs) {
    if (!d.rendered || used003.has(`provenance/Corpus/${d.format}/${d.file}`)) continue;
    let doc;
    try { doc = openDocument(new Uint8Array(readFileSync(d.path))); } catch (e) { if (e instanceof UnsupportedError) continue; throw e; }
    for (const slot of findSlots(doc)) {
      if (slot.kind !== 'blank' || slot.blank !== 'text') continue;
      const p = slot._paragraph;
      if (p.lineSegs().length !== 1 || !['left', 'justify'].includes(doc.paraAlign(p))) continue;
      const { chars } = paragraphChars(p);
      const [part] = slot._blank.parts;
      const run = chars.filter((c) => c.pos >= part.start && c.pos < part.end);
      if (run.length < 6 || run.some((c) => c.ch !== ' ')) continue;
      const after = chars.filter((c) => c.pos >= part.end);
      if (!after.length || after[0].sep || !after.some((c) => !c.sep && c.ch !== ' ')) continue;
      const style = doc.charStyleAt(p, part.start);
      cands.push({ d, id: slot.id, style, key: `${style.face.hangul}|${style.face.latin}`, width: textWidth(' '.repeat(run.length), style) });
    }
  }
  const perKey = new Map();
  let k = 0;
  for (const c of cands.sort((a, b) => rank(`${a.d.file}:${a.id}`) - rank(`${b.d.file}:${b.id}`))) {
    const list = perKey.get(c.key) ?? [];
    if (list.length >= 2 || list.some((x) => x.d.file === c.d.file) || manifest.blanks.length >= 40) continue;
    const prefer = FITTING[k % 2];
    const value = prefer.find((v) => textWidth(` ${v} `, c.style) <= c.width - 0.3);
    if (!value) continue;
    list.push(c);
    perKey.set(c.key, list);
    const doc = openDocument(new Uint8Array(readFileSync(c.d.path)));
    setSlotValue(findSlots(doc).find((s) => s.id === c.id), value);
    k++;
    const stem = await write(`b${opt.batch}-A${String(k).padStart(2, '0')}-${tag(c.d)}-fill.${ext(c.d)}`, doc);
    const [, paragraph, blank] = /^p(\d+)\.b(\d+)$/.exec(c.id).map(Number);
    manifest.blanks.push({ id: k, source: `provenance/Corpus/${c.d.format}/${c.d.file}`, paragraph, blank, style: c.style, key: c.key, value, files: { fill: stem } });
  }

  // Parts B and C.
  const scored = [];
  for (const d of docs) {
    let doc;
    try { doc = openDocument(new Uint8Array(readFileSync(d.path))); } catch (e) { if (e instanceof UnsupportedError) continue; throw e; }
    if (!d.rendered && !/\.hwp$/.test(d.file)) continue;
    const slots = findSlots(doc);
    // Only part F may use forms without a corpus render (it brings its own baseline).
    if (!d.rendered && !slots.some((s) => s.kind === 'choice' && s._options.some((o) => o.kind === 'form'))) continue;
    const blanks = slots.filter((s) => s.kind === 'blank' && s.labels.length).length;
    const choices = slots.filter((s) => s.kind === 'choice').length;
    const kinds = new Set(slots.filter((s) => s.kind === 'choice').flatMap((s) => s._options.map((o) => o.kind)));
    scored.push({ d, blanks, choices, kinds });
  }
  const pick = (list, n) => list.sort((a, b) => rank(a.d.file) - rank(b.d.file)).slice(0, n);
  const partB = pick(scored.filter((x) => x.blanks >= 6 && x.blanks <= 40), 12);
  const kindsOf = (x) => x.kinds ?? new Set();
  const partC = opt.batch === '004'
    ? pick(scored.filter((x) => x.choices >= 2 && x.choices <= 30 && !partB.includes(x)), 10)
    : pick(scored.filter((x) => kindsOf(x).has('bracket') || kindsOf(x).has('paren')).filter((x) => x.choices <= 30 && !partB.includes(x)), 10);
  const parts = [['B', partB], ['C', partC]];
  if (opt.batch !== '004') {
    // F: every corpus form with form-object check boxes or radio buttons.
    const partF = scored.filter((x) => kindsOf(x).has('form'));
    parts.push(['F', partF]);
    for (const { d } of partF.filter(({ d }) => !d.rendered)) {
      const doc = openDocument(new Uint8Array(readFileSync(d.path)));
      const stem = `b${opt.batch}-R-${tag(d)}-resave`;
      writeFileSync(join(FILES, `${stem}.${ext(d)}`), await doc.toBytes({ rewriteAll: true }));
      manifest.baselines = { ...(manifest.baselines ?? {}), [`provenance/Corpus/${d.format}/${d.file}`]: stem };
    }
  }
  const inPart = (part, s) => (part === 'C' ? s.kind === 'choice' && (opt.batch === '004' || s._options.some((o) => o.kind === 'bracket' || o.kind === 'paren'))
    : part === 'F' ? s.kind === 'choice' && s._options.some((o) => o.kind === 'form')
      : s.labels.length || s.kind === 'choice');
  for (const [part, list] of parts) {
    for (const [n, { d }] of list.entries()) {
      const doc = openDocument(new Uint8Array(readFileSync(d.path)));
      const slots = findSlots(doc).filter((s) => inPart(part, s));
      const record = Object.fromEntries(slots.map((s) => [s.id, plausible(s)]).filter(([, v]) => v));
      const report = fillSlots(slots, record);
      const stem = await write(`b${opt.batch}-${part}${String(n + 1).padStart(2, '0')}-${tag(d)}.${ext(d)}`, doc);
      manifest.forms.push({ part, file: stem, source: `provenance/Corpus/${d.format}/${d.file}`,
        expect: part === 'B' ? { samePageCount: true } : { boxesOnly: report.filled.length },
        filled: report.filled.map(({ slot, value }) => ({ slot, value })), failed: report.failed });
    }
  }
  writeFileSync(join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const n = manifest.blanks.length + manifest.forms.length;
  writeFileSync(join(DIR, 'README.md'), `# Render batch ${opt.batch} (verification of blanks and check boxes)

${n} files in \`files/\`, made by \`node tools/render/make-verification.js --batch ${opt.batch}\`.
Render them like the earlier batches, then run
\`python3 tools/render/verify.py render-batches/${opt.batch}\`.

* A (${manifest.blanks.length} files): one blank filled with a value that fits; the text after it must not move.
* B (${partB.length} files): whole forms filled, for review by eye; the page count must not change.
* C (${partC.length} files): check boxes set; the only changes must be box-sized marks.
${manifest.forms.some((f) => f.part === 'F') ? `* F (${manifest.forms.filter((f) => f.part === 'F').length} files): form-object check boxes and radio buttons set; the only changes must be box-sized marks.\n` : ''}`);
  console.log(`wrote ${n} files to ${FILES}: A ${manifest.blanks.length}, B ${partB.length}, C ${partC.length}, F ${manifest.forms.filter((f) => f.part === 'F').length}, baselines ${Object.keys(manifest.baselines ?? {}).length}`);
}

await main();
