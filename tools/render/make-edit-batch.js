#!/usr/bin/env node
// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Makes a render batch for text edits and for coloured text turned black
// (engine/src/form/edit.js, colour.js), checked by tools/render/verify-edits.py
// against the corpus renders:
//
//   K  one coloured stretch per file turned black, with no change of text
//      (a black copy of its character shape is found or added; in HWPX the
//      run is split around it): the render may differ only where that
//      coloured text was, and there it must no longer be coloured;
//   E  placeholders and notes edited by hand (0032, 0033, 0037) and empty
//      cells written into, for review by eye: the page count must not change.
//
// Usage: node tools/render/make-edit-batch.js [--batch 006] [--out render-batches]

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDocument, findSlots, documentOutline, fillForm, paragraphList, validate } from '../../engine/src/index.js';
import { recolour } from '../../engine/src/form/colour.js';
import { crc32 } from '../../engine/src/util/crc32.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CORPUS = join(ROOT, 'provenance/Corpus');
const { values: opt } = parseArgs({ options: { batch: { type: 'string', default: '006' }, out: { type: 'string', default: join(ROOT, 'render-batches') } } });
const DIR = join(opt.out, opt.batch);
const FILES = join(DIR, 'files');
const rank = (s) => crc32(new TextEncoder().encode(`edits:${s}`));
const K_COUNT = { hwp5: 14, hwpx: 10 };

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

/** Corpus forms that have a render to compare with. */
function rendered(format) {
  const dir = join(CORPUS, format);
  return readdirSync(dir).filter((f) => /\.hwpx?$/i.test(f) && existsSync(join(dir, `${f.replace(/\.[^.]+$/, '')}_p001.jpg`))).sort();
}

const tag = (file) => file.replace(/\.[^.]+$/, '');
const ext = (format) => (format === 'hwpx' ? 'hwpx' : 'hwp');
const edit = (s, to) => ({ p: s.p, start: s.start, end: s.end, from: s.text, to });

async function main() {
  if (existsSync(FILES) && readdirSync(FILES).length) throw new Error(`${FILES} is not empty; choose another --batch`);
  mkdirSync(FILES, { recursive: true });
  const manifest = { batch: opt.batch, recolour: [], edits: [] };

  // K: coloured stretches turned black, text unchanged.
  for (const format of ['hwp5', 'hwpx']) {
    let n = 0;
    for (const file of rendered(format).sort((a, b) => rank(a) - rank(b))) {
      if (n >= K_COUNT[format]) break;
      const bytes = new Uint8Array(readFileSync(join(CORPUS, format, file)));
      let doc;
      try { doc = openDocument(bytes); } catch { continue; }
      // A clearly coloured stretch of a few characters, preferring one that shares its run with other text.
      const candidates = segments(doc).filter((s) => s.color && s.text.trim().length >= 2 && !s.text.includes('\ufffd') && validColour(s.color));
      if (!candidates.length) continue;
      const shared = candidates.filter((s) => runGoesOn(paragraphList(doc)[s.p], s));
      const s = (shared.length && n % 2 === 0 ? shared : candidates)[0];
      const paragraph = paragraphList(doc)[s.p];
      const before = doc.styles.charShapes.filter(Boolean).length;
      if (!recolour(doc, paragraph, s.start, s.end)) continue;
      if (validate(doc).length) throw new Error(`${file}: ${validate(doc).join('; ')}`);
      const added = doc.styles.charShapes.filter(Boolean).length - before;
      const stem = `b${opt.batch}-K${String(++n).padStart(2, '0')}-${format}-${tag(file)}`;
      writeFileSync(join(FILES, `${stem}.${ext(format)}`), await doc.toBytes());
      manifest.recolour.push({ file: stem, source: `provenance/Corpus/${format}/${file}`, text: s.text, colour: s.color, splitRun: runGoesOn(paragraph, s), addedShapes: added });
    }
  }

  // E: edits by hand.
  const E = [];
  const find = (segs, test, what) => {
    const s = segs.find(test);
    if (!s) throw new Error(`not found: ${what}`);
    return s;
  };
  const plan = [
    ['hwp5', '0037.hwp', (segs) => [
      edit(find(segs, (s) => s.text.includes('채무자의 관리인 OOO은'), 'OOO은'), find(segs, (s) => s.text.includes('채무자의 관리인 OOO은'), '').text.replace('OOO은', '홍길동은')),
      edit(find(segs, (s) => s.color && s.text === '(간이)', '(간이)'), '(일반)'),
      edit(find(segs, (s) => s.text.includes('20OO. OO. OO'), '20OO. OO. OO'), find(segs, (s) => s.text.includes('20OO. OO. OO'), '').text.replace('20OO. OO. OO', '2026. 10. 09')),
    ]],
    ['hwp5', '0032.hwp', (segs) => [edit(find(segs, (s) => s.text.includes('대량일 경우'), '대량일 경우'), 'https://example.com/works')]],
    ['hwp5', '0033.hwp', (segs) => {
      const a = find(segs, (s) => s.text.includes('처리과명-연도별 일련번호(시행일)'), '시행');
      const b = find(segs, (s) => s.text.includes('도로명주소'), '도로명주소');
      return [edit(a, a.text.replace('처리과명-연도별 일련번호(시행일)', '총무과-2026-123(2026. 10. 9.)')), edit(b, b.text.replace('도로명주소', '서울특별시 중구 세종대로 110'))];
    }],
  ];
  // Empty cells written into, one HWP 5.0 and one HWPX form.
  for (const format of ['hwp5', 'hwpx']) {
    for (const file of rendered(format).sort((a, b) => rank(`empty:${a}`) - rank(`empty:${b}`))) {
      let doc;
      try { doc = openDocument(new Uint8Array(readFileSync(join(CORPUS, format, file)))); } catch { continue; }
      const empty = segments(doc).filter((s) => s.inCell && s.text === '');
      if (empty.length < 2) continue;
      plan.push([format, file, (segs) => segs.filter((s) => s.inCell && s.text === '').slice(0, 2).map((s, i) => edit(s, i ? '두 번째 칸' : '빈 칸에 적은 글'))]);
      break;
    }
  }
  for (const [format, file, make] of plan) {
    const bytes = new Uint8Array(readFileSync(join(CORPUS, format, file)));
    const edits = make(segments(openDocument(bytes)));
    const { bytes: out, report } = await fillForm(bytes, {}, { edits });
    if (report.edits.failed.length) throw new Error(`${file}: ${JSON.stringify(report.edits.failed)}`);
    const stem = `b${opt.batch}-E${String(E.length + 1).padStart(2, '0')}-${format}-${tag(file)}`;
    writeFileSync(join(FILES, `${stem}.${ext(format)}`), out);
    E.push(stem);
    manifest.edits.push({ file: stem, source: `provenance/Corpus/${format}/${file}`, edits: edits.map((e) => ({ from: e.from, to: e.to })) });
  }

  writeFileSync(join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(DIR, 'README.txt'), `Render batch ${opt.batch}: text edits and coloured text turned black.

Render every file in files/ as before (pages as <stem>_pNNN.jpg next to the file).

* K (${manifest.recolour.length} files): one coloured stretch per file turned black, text unchanged.
  The render may differ from the corpus render only where that text was.
* E (${manifest.edits.length} files): placeholders and notes edited by hand, empty cells written into.
  Same page count; for review by eye.
`);
  console.log(`wrote ${manifest.recolour.length + manifest.edits.length} files to ${FILES}: K ${manifest.recolour.length} (${manifest.recolour.filter((k) => k.splitRun).length} sharing a run, ${manifest.recolour.filter((k) => k.addedShapes).length} adding a shape), E ${manifest.edits.length}`);
}

/** Pure colours that show clearly in a render (not greys). */
function validColour(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b) >= 0x80;
}

/** Whether the stretch's character shape run goes on past it (so the run must be split). */
function runGoesOn(paragraph, s) {
  if (paragraph.charShapes) {
    const shapes = paragraph.charShapes();
    const i = shapes.findLastIndex((x) => x.pos <= s.start);
    return shapes[i].pos < s.start || (shapes[i + 1]?.pos ?? Infinity) > s.end;
  }
  const units = paragraph.units();
  const run = units.find((u) => u.pos === s.start)?.run;
  return units.some((u) => u.run === run && (u.pos < s.start || u.pos >= s.end));
}

main().catch((e) => { console.error(e); process.exit(1); });
