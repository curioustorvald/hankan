#!/usr/bin/env node
// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Makes a calibration batch: corpus forms in which one blank of spaces is
// changed in a controlled way, so that the renders show how wide characters
// print. Each file changes one blank only; the text after the blank on the
// same line moves by exactly the change in width, which
// tools/render/calibrate.py measures against the corpus render.
//
// Variants of each chosen blank (two spaces in the blank, from its second
// character, are changed):
//   del2  removed                     → shift = −2·space
//   han2  replaced by "가가"            → shift = 2·(hangul − space)
//   dig2  replaced by "00"             → shift = 2·(digit − space)
//   low2  replaced by "an"             → shift = 2·(lower − space)
//   hyp2  replaced by "--"             → shift = 2·(hyphen − space)
//   fill  the blank filled with a value by the engine, with the widths it
//         knows at the time            → shift = the engine's error
//
// Blanks are chosen in single-line, left-aligned or justified paragraphs,
// with text after them on the line, and from forms that have a corpus
// render; up to 3 per combination of Hangul and Latin font.
//
// Usage: node tools/render/make-calibration.js [--batch 003] [--out render-batches]

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDocument, findSlots, setSlotValue, validate, UnsupportedError } from '../../engine/src/index.js';
import { paragraphChars } from '../../engine/src/form/inline.js';
import { crc32 } from '../../engine/src/util/crc32.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CORPUS = join(ROOT, 'provenance/Corpus');
const { values: opt } = parseArgs({ options: { batch: { type: 'string', default: '003' }, out: { type: 'string', default: join(ROOT, 'render-batches') } } });
const DIR = join(opt.out, opt.batch);
const FILES = join(DIR, 'files');

const PROBES = { del2: '', han2: '가가', dig2: '00', low2: 'an', hyp2: '--' };
const FILL_VALUE = '홍길동 010-1234';
const rank = (s) => crc32(new TextEncoder().encode(`calibration:${s}`));

function candidates() {
  const out = [];
  for (const format of ['hwp5', 'hwpx']) {
    const dir = join(CORPUS, format);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => /\.hwpx?$/.test(f)).sort()) {
      const stem = file.replace(/\.[^.]+$/, '');
      if (!existsSync(join(dir, `${stem}_p001.jpg`))) continue; // needs a corpus render to compare with
      let doc;
      try { doc = openDocument(new Uint8Array(readFileSync(join(dir, file)))); } catch (e) { if (e instanceof UnsupportedError) continue; throw e; }
      // Only blanks the filler offers as slots.
      for (const slot of findSlots(doc)) {
        if (slot.kind !== 'blank' || slot.blank !== 'text') continue;
        const paragraph = slot._paragraph;
        const [, pIndex, n] = /^p(\d+)\.b(\d+)$/.exec(slot.id).map(Number);
        if (paragraph.lineSegs().length !== 1) continue;
        const align = doc.paraAlign(paragraph);
        if (align !== 'left' && align !== 'justify') continue;
        const { chars } = paragraphChars(paragraph);
        const [p] = slot._blank.parts;
        const run = chars.filter((c) => c.pos >= p.start && c.pos < p.end);
        if (run.length < 4 || run.some((c) => c.ch !== ' ')) continue;
        const after = chars.filter((c) => c.pos >= p.end);
        if (!after.length || after[0].sep || !after.some((c) => !c.sep && c.ch !== ' ')) continue;
        if (paragraph.charShapeIdAt(p.start) !== paragraph.charShapeIdAt(p.end - 1)) continue;
        const style = doc.charStyleAt(paragraph, p.start);
        out.push({
          format, file, stem, pIndex, n, start: p.start, end: p.end, align, style,
          key: `${style.face.hangul}|${style.face.latin}|${style.fontSpace ? 'fontSpace' : 'space'}`,
          label: slot.display.join(' '), text: paragraph.text,
        });
      }
    }
  }
  return out;
}

function choose(all) {
  const byKey = new Map();
  for (const c of all) (byKey.get(c.key) ?? byKey.set(c.key, []).get(c.key)).push(c);
  const chosen = [];
  for (const [key, list] of [...byKey].sort((a, b) => b[1].length - a[1].length)) {
    if (list.length < 4) continue;
    const want = list.length >= 25 ? 3 : 2;
    const docs = new Set();
    for (const c of list.sort((a, b) => rank(`${a.file}:${a.pIndex}:${a.n}`) - rank(`${b.file}:${b.pIndex}:${b.n}`))) {
      if (docs.has(c.file)) continue;
      docs.add(c.file);
      chosen.push(c);
      if (docs.size >= want) break;
    }
  }
  return chosen;
}

async function main() {
  if (existsSync(FILES) && readdirSync(FILES).some((f) => /\.hwpx?$/.test(f))) {
    throw new Error(`${FILES} already holds documents; use another --batch or empty it first`);
  }
  mkdirSync(FILES, { recursive: true });
  const chosen = choose(candidates());
  const manifest = { batch: opt.batch, kind: 'calibration', created: new Date().toISOString(), probes: PROBES, fillValue: FILL_VALUE, blanks: [] };
  for (const [k, c] of chosen.entries()) {
    const src = new Uint8Array(readFileSync(join(CORPUS, c.format, c.file)));
    const entry = { id: k + 1, source: `provenance/Corpus/${c.format}/${c.file}`, paragraph: c.pIndex, blank: c.n, start: c.start, end: c.end,
      runLength: c.end - c.start, align: c.align, style: c.style, key: c.key, label: c.label, text: c.text, files: {} };
    for (const variant of [...Object.keys(PROBES), 'fill']) {
      const doc = openDocument(src);
      const paragraph = [...doc.walk()][c.pIndex].paragraph;
      if (variant === 'fill') {
        const slot = findSlots(doc).find((s) => s.id === `p${c.pIndex}.b${c.n}`);
        if (!slot) throw new Error(`${c.file}: blank p${c.pIndex}.b${c.n} not found as a slot`);
        setSlotValue(slot, FILL_VALUE);
      } else {
        paragraph.replaceRange(c.start + 1, c.start + 3, PROBES[variant]);
      }
      const problems = validate(doc);
      if (problems.length) throw new Error(`${c.file} ${variant}: ${problems[0]}`);
      const name = `b${opt.batch}-${String(k + 1).padStart(2, '0')}-${c.format}-${c.stem}-${variant}.${c.format === 'hwpx' ? 'hwpx' : 'hwp'}`;
      writeFileSync(join(FILES, name), await doc.toBytes());
      entry.files[variant] = name.replace(/\.[^.]+$/, '');
    }
    manifest.blanks.push(entry);
  }
  writeFileSync(join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const n = manifest.blanks.length * (Object.keys(PROBES).length + 1);
  writeFileSync(join(DIR, 'README.md'), `# Render batch ${opt.batch} (calibration)

${n} files in \`files/\`: ${manifest.blanks.length} blanks × ${Object.keys(PROBES).length + 1} variants, made by
\`node tools/render/make-calibration.js --batch ${opt.batch}\`. Render them like the
earlier batches (\`<name>_p001.jpg\` next to the files), then run
\`python3 tools/render/calibrate.py render-batches/${opt.batch}\`.

| # | source | fonts (Hangul, Latin, space) | label |
|---|---|---|---|
${manifest.blanks.map((b) => `| ${b.id} | ${b.source.replace('provenance/Corpus/', '')} | ${b.key} | ${b.label} |`).join('\n')}
`);
  console.log(`wrote ${n} files for ${manifest.blanks.length} blanks to ${FILES}`);
}

await main();
