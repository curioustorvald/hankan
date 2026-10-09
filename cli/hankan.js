#!/usr/bin/env node
// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Command-line form filler: fills .hwp/.hwpx forms from CSV or JSON data.

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ATTRIBUTION, openDocument, findSlots, fillForm, csvRecords, jsonRecords, decodeText, DEFAULT_ALIASES,
} from '../engine/src/index.js';

const VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `hankan ${VERSION}: fill .hwp/.hwpx forms from CSV or JSON data

Usage:
  hankan <form|dir>... <data.csv|data.json> [-o out/]
  hankan --list <form|dir>...

Forms are .hwp (HWP 5.0) or .hwpx files, or directories holding them.
Data is a CSV file with a header row, or JSON (an object or an array of
objects). Every form is filled once per data row, so one form with a
100-row CSV gives 100 files, and a directory of forms with a one-row
"about me" file fills each form with the same details.

A data column fills the blanks whose printed label it names: "성명",
"주소", "성명(영문)", or a key shown by --list such as "자격증#2" or
"t1.r2c3". Common synonyms match too (이름 = 성명, 휴대폰 = 휴대전화, ...).
A bare name never fills another party's blank (대리인, 배우자, ...): name it
in full, e.g. "대리인.성명".

Dates take "2026-10-09" or "오늘"; numbers printed in parts take
"900101-1234567". Check boxes take the option to mark ("있음", or several:
"우편, 팩스"), or Y/N for a single box; a marked box is shown filled (□ → ■).

Options:
  -o, --output <dir>      where to write filled files (default: ./filled)
  -l, --list              list each form's blanks and their keys; no data needed
      --all               with --list, also show blanks with no label (often
                          spacing cells of the layout; only filled when
                          named by id)
      --json              print --list or the fill report as JSON
  -n, --name <template>   output file name; {form} is the form's name, {row}
                          the row number, {column} any data column
                          (default: {form}, or {form}-{row} for several rows)
      --set <col=value>   add or override a value for every row (repeatable)
      --alias <a,b,...>   treat these words as synonyms (repeatable)
      --dry-run           report what would be filled; write nothing
      --strict            fail when a column is ambiguous
  -h, --help              this help
  -v, --version           version

The original form is never modified. Only the paragraphs that receive
data change; everything else in the file is kept byte for byte.

We try our best to make it just work, but the filled form may still come
out skewed. If the document is important, check the result with another
program, such as the Hancom Docs viewer.

${ATTRIBUTION}
`;

const FORM_EXT = new Set(['.hwp', '.hwpx']);
const DATA_EXT = new Set(['.csv', '.tsv', '.txt', '.json']);

async function main(argv) {
  const { values: opt, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' },
      input: { type: 'string', short: 'i', multiple: true },
      list: { type: 'boolean', short: 'l' },
      all: { type: 'boolean' },
      json: { type: 'boolean' },
      name: { type: 'string', short: 'n' },
      set: { type: 'string', multiple: true },
      alias: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean' },
      strict: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (opt.help) { process.stdout.write(HELP); return 0; }
  if (opt.version) { console.log(VERSION); return 0; }

  const formArgs = [...(opt.input ?? [])];
  const dataArgs = [];
  for (const p of positionals) {
    const isDir = await stat(p).then((s) => s.isDirectory(), () => false);
    if (isDir || FORM_EXT.has(extname(p).toLowerCase())) formArgs.push(p);
    else if (DATA_EXT.has(extname(p).toLowerCase())) dataArgs.push(p);
    else throw new UsageError(`don't know what ${p} is: expected a form (.hwp, .hwpx, directory) or data (.csv, .json)`);
  }
  const forms = await collectForms(formArgs);
  if (!forms.length) throw new UsageError('no forms given (try --help)');

  if (opt.list) return listForms(forms, opt);

  const records = await loadRecords(dataArgs, opt.set ?? []);
  if (!records.length) throw new UsageError('no data: give a CSV or JSON file, or --set column=value');
  const aliases = [...DEFAULT_ALIASES, ...(opt.alias ?? []).map((a) => a.split(/[,=]/).map((x) => x.trim()).filter(Boolean))];
  return fillAll(forms, records, { ...opt, aliases });
}

class UsageError extends Error {}

async function collectForms(paths) {
  const out = [];
  for (const p of paths) {
    const s = await stat(p).catch(() => null);
    if (!s) throw new UsageError(`no such file or directory: ${p}`);
    if (s.isDirectory()) {
      const names = (await readdir(p)).filter((n) => FORM_EXT.has(extname(n).toLowerCase())).sort();
      out.push(...names.map((n) => join(p, n)));
    } else {
      out.push(p);
    }
  }
  return out;
}

async function loadRecords(dataPaths, sets) {
  let records = [];
  for (const p of dataPaths) {
    const text = decodeText(new Uint8Array(await readFile(p)));
    const ext = extname(p).toLowerCase();
    const recs = ext === '.json' ? jsonRecords(text) : csvRecords(text, ext === '.tsv' ? '\t' : undefined);
    records = records.length ? records.flatMap((a) => recs.map((b) => ({ ...a, ...b }))) : recs;
  }
  const extra = {};
  for (const s of sets) {
    const i = s.indexOf('=');
    if (i < 1) throw new UsageError(`--set expects column=value, got ${s}`);
    extra[s.slice(0, i).trim()] = s.slice(i + 1);
  }
  if (!records.length && Object.keys(extra).length) records = [{}];
  return records.map((r) => ({ ...r, ...extra }));
}

async function listForms(forms, opt) {
  const result = [];
  for (const path of forms) {
    try {
      const slots = findSlots(openDocument(new Uint8Array(await readFile(path))));
      result.push({ form: path, slots: slots.map(({ id, kind, key, labels, display, group, hint, value }) => ({ key, id, kind, label: display.join(' / '), labelled: labels.some(Boolean), group, hint, value })) });
    } catch (e) {
      result.push({ form: path, error: e.message });
    }
  }
  if (opt.json) { console.log(JSON.stringify(result, null, 2)); return 0; }
  for (const r of result) {
    console.log(`\n${r.form}`);
    if (r.error) { console.log(`  cannot read: ${r.error}`); continue; }
    if (!r.slots.length) { console.log('  no blanks found'); continue; }
    const shown = opt.all ? r.slots : r.slots.filter((s) => s.labelled);
    const hidden = r.slots.length - shown.length;
    const w = Math.min(36, Math.max(0, ...shown.map((s) => width(s.key))));
    if (hidden) console.log(`  (${hidden} blank${hidden > 1 ? 's' : ''} without a label not shown; --all shows them)`);
    for (const s of shown) {
      const extra = [s.group && `[${s.group}]`, s.hint && `안내: ${s.hint}`, s.value && `현재: ${s.value}`].filter(Boolean).join('  ');
      console.log(`  ${pad(s.key, w)}  ${s.id.padEnd(12)} ${extra}`);
    }
  }
  return result.some((r) => r.error) ? 1 : 0;
}

async function fillAll(forms, records, opt) {
  const outDir = resolve(opt.output ?? 'filled');
  if (!opt['dry-run']) await mkdir(outDir, { recursive: true });
  const template = opt.name ?? (records.length > 1 ? '{form}-{row}' : '{form}');
  const used = new Set();
  const results = [];
  let failed = 0;
  for (const path of forms) {
    let bytes;
    try { bytes = new Uint8Array(await readFile(path)); } catch (e) { results.push({ form: path, error: e.message }); failed++; continue; }
    for (const [i, record] of records.entries()) {
      const entry = { form: path, row: i + 1 };
      try {
        const { bytes: out, report } = await fillForm(bytes, record, { aliases: opt.aliases });
        Object.assign(entry, report);
        const name = uniqueName(outputName(template, path, i + 1, record), extname(path), used);
        entry.output = join(outDir, name);
        if (!opt['dry-run']) await writeFile(entry.output, out);
        if (opt.strict && report.ambiguous.length) { entry.error = 'ambiguous columns'; failed++; }
      } catch (e) {
        entry.error = e.message;
        failed++;
      }
      results.push(entry);
    }
  }
  if (opt.json) console.log(JSON.stringify(results, null, 2));
  else for (const r of results) printResult(r, opt);
  return failed ? 1 : 0;
}

function printResult(r, opt) {
  const where = `${r.form}${r.row ? ` #${r.row}` : ''}`;
  if (r.error && !r.output) { console.log(`✗ ${where}: ${r.error}`); return; }
  const verb = opt['dry-run'] ? 'would write' : '→';
  console.log(`${r.error ? '✗' : '✓'} ${where} ${verb} ${r.output}: ${r.filled.length} filled`);
  for (const f of r.failed) console.log(`    not filled: ${f.slot} ("${f.column}"): ${f.error}`);
  for (const a of r.ambiguous) console.log(`    ambiguous: "${a.column}" could be ${a.candidates.join(', ')}`);
  for (const c of r.conflicts) console.log(`    conflict: ${c.slot} named by both "${c.columns[0]}" and "${c.columns[1]}"`);
}

function outputName(template, path, row, record) {
  const form = basename(path, extname(path));
  const name = template.replace(/\{([^{}]+)\}/g, (m, k) => (k === 'form' ? form : k === 'row' ? String(row) : record[k] ?? ''));
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || form;
}

function uniqueName(stem, ext, used) {
  let name = stem + ext;
  for (let k = 2; used.has(name); k++) name = `${stem} (${k})${ext}`;
  used.add(name);
  return name;
}

/** Display width, counting Hangul and other wide characters as 2 columns. */
function width(s) {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

function pad(s, w) {
  return s + ' '.repeat(Math.max(0, w - width(s)));
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => {
    if (e instanceof UsageError || e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      console.error(`hankan: ${e.message}`);
      process.exitCode = 2;
    } else {
      console.error(e.stack);
      process.exitCode = 1;
    }
  },
);
