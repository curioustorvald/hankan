#!/usr/bin/env node
// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Makes a batch of filled corpus forms to be rendered on the Windows machine,
// to answer the questions in PROVENANCE.md ("Open questions for the
// rendering corpus"). Only the .hwp/.hwpx files go to that machine; the
// manifest stays here and maps every file back to its source, variant and
// the values put into each blank.
//
// Batch 001 (the first questions). Variants of each selected form:
//   resave       nothing filled; sections re-encoded and rewritten. Must render
//                exactly like the original (checks the writers and compression).
//   short-keep   short values; edited paragraphs keep their layout cache
//   short-drop   short values; edited paragraphs lose their layout cache
//   long-keep    values long enough to wrap in most cells; cache kept
//   long-drop    the same; cache dropped
//   multi-keep   three-line values (line breaks); cache kept
//   multi-drop   the same; cache dropped
//   fieldclean   (forms with click-here fields only) short values, fields
//                not marked as modified
//
// Batch 002 (checks the changes made after batch 001, PROVENANCE.md R1–R3):
// the engine's defaults (layout cache dropped, field text in the field's
// style), variants resave / short / long / multi, on the forms whose batch-001
// renders raised the questions. Each file carries the result expected of its
// render (`expect` in the manifest), checked by tools/render/compare.py:
//   sameAs     pixel-identical to a batch-001 render (the renderer is deterministic)
//   noNewRed   no red text beyond what the unfilled form has (guide text style)
//
// Usage: node tools/render/make-batch.js [--batch 001] [--out render-batches]

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDocument, findSlots, fillForm, UnsupportedError } from '../../engine/src/index.js';
import { crc32 } from '../../engine/src/util/crc32.js';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CORPUS = join(ROOT, 'provenance/Corpus');
const { values: opt } = parseArgs({ options: { batch: { type: 'string', default: '001' }, out: { type: 'string', default: join(ROOT, 'render-batches') } } });
const BATCH = opt.batch;
const DIR = join(opt.out, BATCH);
const FILES = join(DIR, 'files');

const VALUES = {
  short: (i) => `테스트${i}`,
  long: (i) => `긴 값 ${i}: 가나다라마바사 아자차카타파하 가나다라마바사 아자차카타파하 ABCDEFG 0123456789`,
  multi: (i) => `여러 줄 ${i}\n둘째 줄\n셋째 줄`,
};
const VARIANTS_001 = [
  { name: 'resave', rewriteAll: true },
  { name: 'short-keep', values: 'short', lineSegs: 'keep' },
  { name: 'short-drop', values: 'short', lineSegs: 'drop' },
  { name: 'long-keep', values: 'long', lineSegs: 'keep' },
  { name: 'long-drop', values: 'long', lineSegs: 'drop' },
  { name: 'multi-keep', values: 'multi', lineSegs: 'keep' },
  { name: 'multi-drop', values: 'multi', lineSegs: 'drop' },
  { name: 'fieldclean', values: 'short', lineSegs: 'keep', markFieldsModified: false, fieldsOnly: true },
];

const VARIANTS_002 = [
  { name: 'resave', rewriteAll: true },
  { name: 'short', values: 'short' },
  { name: 'long', values: 'long' },
  { name: 'multi', values: 'multi' },
];

/** A stable pseudo-random order, so that the selection is the same on every run. */
const rank = (name) => crc32(new TextEncoder().encode(`batch-${BATCH}:${name}`));

function survey() {
  const out = [];
  for (const format of ['hwp5', 'hwpx']) {
    const dir = join(CORPUS, format);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => /\.hwpx?$/i.test(f)).sort()) {
      const bytes = new Uint8Array(readFileSync(join(dir, file)));
      let doc;
      try { doc = openDocument(bytes); } catch (e) { if (e instanceof UnsupportedError) continue; throw e; }
      const slots = findSlots(doc);
      out.push({
        format, file, path: join(dir, file),
        version: format === 'hwp5' ? String(doc.header.version) : null,
        compressed: format === 'hwp5' ? doc.header.compressed : true,
        sections: doc.sections.length,
        cells: slots.filter((s) => s.kind === 'cell').length,
        fields: slots.filter((s) => s.kind === 'field').length,
      });
    }
  }
  return out;
}

function select001(all) {
  const picked = new Map();
  const take = (list, n, reason) => {
    for (const d of list.filter((x) => !picked.has(x.path)).sort((a, b) => rank(a.file) - rank(b.file)).slice(0, n)) {
      picked.set(d.path, { ...d, reason });
    }
  };
  const hwp5 = all.filter((d) => d.format === 'hwp5');
  const hwpx = all.filter((d) => d.format === 'hwpx');
  const usual = (d) => d.cells >= 5 && d.cells <= 80;
  take(hwp5.filter((d) => d.fields > 0), 8, 'click-here fields');
  take(hwpx.filter((d) => d.fields > 0), 2, 'click-here fields');
  const groups = { '5.0.0': /^5\.0\.0\./, '5.0.1-2': /^5\.0\.[12]\./, '5.0.3': /^5\.0\.3\./, '5.0.4-5': /^5\.0\.[45]\./, '5.1': /^5\.1\./ };
  for (const [g, re] of Object.entries(groups)) take(hwp5.filter((d) => re.test(d.version) && usual(d)), 3, `format version ${g}`);
  take(hwp5.filter((d) => !d.compressed && d.cells > 0), 1, 'uncompressed streams');
  take(hwp5.filter((d) => d.sections > 1 && d.cells > 0), 1, 'several sections');
  take(hwp5.filter((d) => d.cells > 150), 1, 'many blanks');
  take(hwpx.filter(usual), 7, 'hwpx');
  return [...picked.values()];
}

/** Batch 002: forms named by what their batch-001 renders showed. */
const SOURCES_002 = {
  'layout cache trusted by old formats (R1)': ['hwp5/1079.hwp', 'hwp5/1239.hwp', 'hwp5/2152.hwp', 'hwp5/0506.hwp', 'hwp5/1871.hwp', 'hwp5/0361.hwp', 'hwp5/0697.hwp'],
  'click-here guide style (R2)': ['hwp5/0832.hwp', 'hwp5/0057.hwp', 'hwp5/0745.hwp', 'hwp5/1690.hwp', 'hwp5/2582.hwp', 'hwp5/0338.hwp', 'hwp5/2221.hwp', 'hwp5/1618.hwp', 'hwpx/0334.hwpx'],
  'more guide-styled click-here fields (R2, C9, C10)': ['hwp5/0085.hwp', 'hwp5/2051.hwp', 'hwp5/2156.hwp', 'hwp5/2598.hwp'],
  'regression': ['hwp5/0088.hwp', 'hwp5/0043.hwp', 'hwpx/2065.hwpx', 'hwpx/2640.hwpx'],
};

function select002(all) {
  const bySource = new Map(all.map((d) => [`${d.format}/${d.file}`, d]));
  return Object.entries(SOURCES_002).flatMap(([reason, list]) => list.map((src) => ({ ...bySource.get(src), reason })));
}

/** What the render of a batch-002 file must show, from the batch-001 manifest. */
function expect002(form, variant) {
  if (variant.name === 'resave') return { sameAsSource: true };
  const m001 = JSON.parse(readFileSync(join(opt.out, '001', 'manifest.json'), 'utf8'));
  const source = `provenance/Corpus/${form.format}/${form.file}`;
  const earlier = (v) => m001.files.find((f) => f.source === source && f.variant === v)?.file.replace(/\.[^.]+$/, '');
  if (form.fields) return { noNewRed: true };
  return { sameAs: earlier(`${variant.name}-drop`) };
}

const BATCHES = {
  '001': { select: select001, variants: VARIANTS_001, expect: () => null },
  '002': { select: select002, variants: VARIANTS_002, expect: expect002 },
};

async function main() {
  const def = BATCHES[BATCH];
  if (!def) throw new Error(`unknown batch ${BATCH}; known: ${Object.keys(BATCHES).join(', ')}`);
  const VARIANTS = def.variants;
  if (existsSync(FILES) && readdirSync(FILES).some((f) => /\.hwpx?$/.test(f))) {
    throw new Error(`${FILES} already holds documents; use another --batch or empty it first`);
  }
  mkdirSync(FILES, { recursive: true });
  const forms = def.select(survey());
  // Files identical to ones of an earlier batch are not rendered again: the
  // manifest points at the earlier file's render instead (`renderOf`).
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const earlier = new Map();
  for (const b of readdirSync(opt.out).filter((d) => d < BATCH && existsSync(join(opt.out, d, 'files')))) {
    for (const f of readdirSync(join(opt.out, b, 'files')).filter((f) => /\.hwpx?$/.test(f))) {
      earlier.set(sha(readFileSync(join(opt.out, b, 'files', f))), f.replace(/\.[^.]+$/, ''));
    }
  }
  let reused = 0;
  const manifest = { batch: BATCH, created: new Date().toISOString(), variants: VARIANTS.map((v) => v.name), files: [] };
  let n = 0;
  for (const [k, form] of forms.entries()) {
    const bytes = new Uint8Array(readFileSync(form.path));
    const slots = findSlots(openDocument(bytes));
    for (const v of VARIANTS) {
      if (v.fieldsOnly && !form.fields) continue;
      const record = {};
      if (v.values) slots.forEach((s, i) => { record[s.id] = VALUES[v.values](i + 1); });
      const { bytes: out, report } = await fillForm(bytes, record, v);
      if (report.failed.length || report.ambiguous.length || report.unmatched.length) {
        throw new Error(`${form.file} ${v.name}: ${JSON.stringify({ failed: report.failed, ambiguous: report.ambiguous, unmatched: report.unmatched })}`);
      }
      const stem = form.file.replace(/\.[^.]+$/, '');
      const ext = form.format === 'hwpx' ? 'hwpx' : 'hwp';
      const name = `b${BATCH}-${String(k + 1).padStart(2, '0')}-${form.format}-${stem}-${v.name}.${ext}`;
      const renderOf = earlier.get(sha(out)) ?? null;
      if (renderOf) reused++;
      else { writeFileSync(join(FILES, name), out); n++; }
      manifest.files.push({
        renderOf,
        file: name,
        source: `provenance/Corpus/${form.format}/${form.file}`,
        reason: form.reason,
        variant: v.name,
        options: { lineSegs: v.lineSegs ?? null, markFieldsModified: v.markFieldsModified ?? true, rewriteAll: !!v.rewriteAll },
        filled: report.filled.map(({ slot, value }) => ({ slot, value })),
        expect: def.expect(form, v),
      });
    }
  }
  writeFileSync(join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const summary = forms.map((f, k) => `| ${String(k + 1).padStart(2, '0')} | ${f.format}/${f.file} | ${f.version ?? ''} | ${f.cells} | ${f.fields} | ${f.reason} |`).join('\n');
  writeFileSync(join(DIR, 'README.md'), `# Render batch ${BATCH}

${n} files in \`files/\`, made by \`node tools/render/make-batch.js --batch ${BATCH}\`.${reused ? ` ${reused} further variants came out byte-identical to files of earlier batches; they are not repeated, and the manifest points at the earlier renders (\`renderOf\`).` : ''}
Copy \`files/\` to the Windows machine, render every page of every file to
JPEG with the same viewer and settings as the corpus, and copy the JPEGs back
into this directory (anywhere; \`<name>_p001.jpg\` as for batch 001). \`manifest.json\` maps each file to its source form,
variant and filled values; it does not leave this machine.

Variants: ${VARIANTS.map((v) => '`' + v.name + '`').join(', ')} (see the header of
\`tools/render/make-batch.js\`). A \`resave\` file must render exactly like its
source; other expectations are in the manifest (\`expect\`).

| # | source | version | cells | fields | chosen for |
|---|---|---|---|---|---|
${summary}
`);
  console.log(`wrote ${n} files for ${forms.length} forms to ${FILES}${reused ? `; ${reused} more are identical to earlier files, whose renders are reused` : ''}`);
}

await main();
