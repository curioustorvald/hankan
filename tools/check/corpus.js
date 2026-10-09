#!/usr/bin/env node
// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Compatibility check over the regression corpus (provenance/Corpus).
//
// For every document it parses the file, writes it back unchanged and checks
// the structural invariants the engine relies on. The checks named C1–C9
// verify the corpus observations listed in PROVENANCE.md; any failure is
// printed with the file name. Usage:
//
//   node tools/check/corpus.js [hwp5|hwpx ...] [--limit N] [--verbose]

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hwp5Document } from '../../engine/src/hwp5/document.js';
import { controlMaskOf, PARA_END } from '../../engine/src/hwp5/paragraph.js';
import { Table } from '../../engine/src/hwp5/section.js';
import { TAG, FIELD } from '../../engine/src/hwp5/tags.js';
import { UnsupportedError, bytesEqual, viewOf, Reader } from '../../engine/src/util/bytes.js';
import { parseParameterSet } from '../../engine/src/hwp5/params.js';
import { readFormObject } from '../../engine/src/hwp5/formobject.js';
import { fieldSpans } from '../../engine/src/form/slots.js';
import { parseRecords } from '../../engine/src/hwp5/records.js';
import { DOCINFO } from '../../engine/src/hwp5/tags.js';
import { decodeStream } from '../../engine/src/hwp5/stream.js';
import { HwpxDocument } from '../../engine/src/hwpx/document.js';
import { HwpxTable, HwpxField, HwpxFieldEnd } from '../../engine/src/hwpx/section.js';

const CORPUS = fileURLToPath(new URL('../../provenance/Corpus/', import.meta.url));
const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const verbose = args.includes('--verbose');
const kinds = args.filter((a) => a === 'hwp5' || a === 'hwpx');

class Tally {
  constructor() { this.counts = new Map(); this.failures = []; }
  ok(check) { this.#c(check).ok++; }
  fail(check, file, detail) {
    this.#c(check).fail++;
    if (this.failures.length < 200) this.failures.push(`${check} ${file}: ${detail}`);
  }
  check(check, cond, file, detail) { cond ? this.ok(check) : this.fail(check, file, typeof detail === 'function' ? detail() : detail); }
  #c(check) { if (!this.counts.has(check)) this.counts.set(check, { ok: 0, fail: 0 }); return this.counts.get(check); }
  report(title) {
    console.log(`\n== ${title}`);
    for (const [k, { ok, fail }] of [...this.counts].sort()) console.log(`${fail ? 'FAIL' : 'ok  '} ${k.padEnd(52)} ${ok} passed${fail ? `, ${fail} failed` : ''}`);
    for (const f of this.failures.slice(0, verbose ? 200 : 20)) console.log('  ' + f);
    return [...this.counts.values()].every((c) => c.fail === 0);
  }
}

function files(kind) {
  const dir = CORPUS + kind + '/';
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.hwpx?$/i.test(f)).sort().slice(0, limit).map((f) => [f, dir + f]);
}

async function checkHwp5() {
  const t = new Tally();
  let unsupported = 0;
  for (const [name, path] of files('hwp5')) {
    const bytes = new Uint8Array(readFileSync(path));
    let doc;
    try {
      doc = new Hwp5Document(bytes);
    } catch (e) {
      if (e instanceof UnsupportedError) { unsupported++; if (verbose) console.log(`skip ${name}: ${e.message}`); continue; }
      t.fail('parse', name, e.stack.split('\n').slice(0, 3).join(' | '));
      continue;
    }
    t.ok('parse');

    if (doc.header.compressed) {
      const { trailer } = decodeStream(doc.cfb.read('DocInfo'), true);
      t.check('C1 compressed stream has CRC/size trailer (DocInfo)', trailer, name, 'DocInfo');
    }
    for (const s of doc.sections) {
      const raw = doc.cfb.read(s.path);
      const { data, trailer } = decodeStream(raw, doc.header.compressed);
      if (doc.header.compressed) t.check('C1 compressed stream has CRC/size trailer (BodyText)', trailer, name, s.path);
      t.check('records re-serialise byte for byte', bytesEqual(s.serialize(), data), name, s.path);
    }
    t.check('unchanged document written back byte for byte', bytesEqual(await doc.toBytes(), bytes), name, '');

    let charShapes = null;
    for (const { paragraph: p } of doc.walk()) {
      for (const s of fieldSpans(p)) {
        if (s.field.kind !== 'clickhere') continue;
        const content = p.units().filter((u) => u.type === 'text' && u.pos >= s.begin.end && u.end <= s.end.pos).map((u) => u.text).join('');
        if (!content) continue;
        const shapes = p.charShapes();
        const at = (pos) => shapes.filter((x) => x.pos <= pos).pop()?.id;
        const inner = at(s.begin.end), outer = at(s.begin.pos);
        if (s.field.dirty) {
          t.check('C9 filled click-here text has the field\'s char shape', inner === outer, name, () => `${inner} vs ${outer}`);
        } else {
          charShapes ??= parseRecords(decodeStream(doc.cfb.read('DocInfo'), doc.header.compressed).data).filter((r) => r.tag === DOCINFO.CHAR_SHAPE);
          // 표 33: attribute at byte 46 (bit 0 italic, 표 30), text colour at byte 52.
          const v = viewOf(charShapes[inner].data);
          t.check('C9 untouched click-here guide text has its own italic char shape', inner !== outer && (v.getUint32(46, true) & 1) === 1, name,
            () => `${inner} vs ${outer}, attr ${v.getUint32(46, true).toString(16)}, colour ${v.getUint32(52, true).toString(16)}`);
          t.check('C10 untouched click-here content is its guide text', content === s.field.direction, name, () => `${JSON.stringify(content)} vs ${JSON.stringify(s.field.direction)}`);
        }
      }
    }
    for (const { paragraph: p } of doc.walk()) {
      const cu = p.codeUnits();
      t.check('nChars equals text length', p.nChars === cu.length, name, () => `nChars ${p.nChars}, text ${cu.length}`);
      t.check('text ends with paragraph end', cu[cu.length - 1] === PARA_END, name, () => `last ${cu[cu.length - 1]}`);
      if (p.textRec) t.check('no text record holding only the paragraph end', cu.length > 1, name, '');
      t.check('C3 control mask = OR of control chars except 13', controlMaskOf(cu) === p.controlMask, name,
        () => `stored ${p.controlMask.toString(16)}, computed ${controlMaskOf(cu).toString(16)}`);
      const shapes = p.charShapes();
      t.check('char shape count matches header', shapes.length === p.charShapeCount, name, () => `${shapes.length} vs ${p.charShapeCount}`);
      if (shapes.length) t.check('first char shape at 0', shapes[0].pos === 0, name, () => `${shapes[0].pos}`);
      t.check('char shape positions increase', shapes.every((s, i) => i === 0 || s.pos > shapes[i - 1].pos), name, '');
      if (!p.lineSegRec) t.check('no line seg record: header count 0', p.lineSegCount === 0, name, () => `${p.lineSegCount}`);
      if (p.lineSegRec) {
        const segs = p.lineSegs().map((x) => x.pos);
        t.check('line seg count matches header', segs.length === p.lineSegCount, name, () => `${segs.length} vs ${p.lineSegCount}`);
        t.check('line seg positions non-decreasing, at most the text length', segs.every((x, i) => x <= cu.length && (i === 0 || x >= segs[i - 1])), name, () => `${segs} / ${cu.length}`);
      }
      if (p.rangeTagRec) t.check('range tag count matches header', p.rangeTags().length === p.rangeTagCount, name, '');

      let units;
      try { units = p.units(); t.ok('controls are 8 code units ending with their code'); } catch (e) { t.fail('controls are 8 code units ending with their code', name, e.message); continue; }
      const ext = units.filter((u) => u.type === 'control' && u.kind === 'extended');
      t.check('one control record per extended control char', ext.length === p.controls.length, name, () => `${ext.length} chars, ${p.controls.length} controls`);
      for (const u of units.filter((x) => x.type === 'control')) {
        t.check('control chars end with their code', cu[u.end - 1] === u.code, name, () => `code ${u.code} at ${u.pos}`);
      }
      for (const u of ext) {
        if (!u.control) continue;
        const inline = (cu[u.pos + 1] | (cu[u.pos + 2] << 16)) >>> 0;
        t.check('C6 extended control char carries its control id (or %unk record)', inline === u.control.id || u.control.id === FIELD.UNKNOWN, name, () => `${inline.toString(16)} vs ${u.control.id.toString(16)}`);
      }
      for (const c of p.controls) {
        for (const list of c.lists) {
          if (list.header) t.check('C4 list paragraphs follow their LIST_HEADER', list.declaredCount === list.paragraphs.length, name, () => `${c.idString}: ${list.declaredCount} declared, ${list.paragraphs.length} found`);
        }
        if (c instanceof Table) checkTable(t, name, c);
        const formRec = c.childRecord(TAG.FORM_OBJECT);
        if (formRec) {
          let f = null;
          try { f = readFormObject(formRec.data); } catch (e) { t.fail('C11 form object framing and property text', name, e.message); }
          if (f) {
            t.ok('C11 form object framing and property text');
            t.check('C11 form object type tag known (tbc+ check box, tbr+ radio button)', f.type !== null, name, () => f.tag);
            if (f.type) t.check('C11 check box / radio button has Value:int', /(^| )Value:int:\d( |$)/.test(f.text), name, () => f.text.slice(-80));
          }
        }
        // Only fields' CTRL_DATA is read by the engine (for the field name).
        const data = c.idString.startsWith('%') ? c.childRecord(TAG.CTRL_DATA) : null;
        if (data) {
          let used = -1;
          try { const r = new Reader(data.data); parseParameterSet(r); used = r.pos; } catch { /* reported below */ }
          t.check('C2 field CTRL_DATA parameter set (4-byte item ids) fills its record', used === data.data.length, name, () => `${c.idString}: ${used} of ${data.data.length} bytes`);
        }
      }
    }
  }
  console.log(`\nhwp5: ${unsupported} unsupported documents skipped`);
  return t.report('HWP 5.0');
}

async function checkHwpx() {
  const t = new Tally();
  let unsupported = 0;
  for (const [name, path] of files('hwpx')) {
    const bytes = new Uint8Array(readFileSync(path));
    let doc;
    try {
      doc = new HwpxDocument(bytes);
    } catch (e) {
      if (e instanceof UnsupportedError) { unsupported++; if (verbose) console.log(`skip ${name}: ${e.message}`); continue; }
      t.fail('parse', name, e.stack.split('\n').slice(0, 3).join(' | '));
      continue;
    }
    t.ok('parse');
    t.check('unchanged document written back byte for byte', bytesEqual(await doc.toBytes(), bytes), name, '');
    for (const s of doc.sections) {
      let ok = true;
      for (const el of s.xml.root.descendants()) {
        if (!s.xml.src.startsWith('<' + el.name, el.start) || (!el.selfClosing && !s.xml.src.startsWith('</' + el.name, el.closeStart))) { ok = false; break; }
      }
      t.check('XML offsets point at their tags', ok, name, s.path);
    }
    for (const { paragraph: p } of doc.walk()) {
      const len = p.length;
      const segs = p.lineSegs().map((x) => Number(x.attr('textpos')));
      t.check('C7 lineseg textpos within the paragraph (controls count 8)', segs.every((x) => x <= len), name, () => `${segs} vs ${len}: ${p.text.slice(0, 40)}`);
      t.check('lineseg textpos non-decreasing', segs.every((x, i) => i === 0 || x >= segs[i - 1]), name, () => `${segs}`);
      const ends = new Map(p.controls.filter((c) => c instanceof HwpxFieldEnd).map((c) => [c.beginId, c]));
      for (const c of p.controls) {
        if (c instanceof HwpxField) t.check('fieldBegin has its fieldEnd in the same paragraph', ends.has(c.fieldId), name, () => `${c.type} ${c.fieldId}`);
        if (c instanceof HwpxTable) checkTiling(t, name, c);
      }
    }
  }
  console.log(`\nhwpx: ${unsupported} unsupported documents skipped`);
  return t.report('HWPX');
}

function checkTiling(t, name, table) {
  const covered = new Set();
  let ok = table.cells.length > 0;
  for (const c of table.cells) {
    if (c.colSpan < 1 || c.rowSpan < 1 || c.col + c.colSpan > table.cols || c.row + c.rowSpan > table.rows) { ok = false; break; }
    for (let r = c.row; r < c.row + c.rowSpan; r++) for (let k = c.col; k < c.col + c.colSpan; k++) {
      const key = r * 65536 + k;
      if (covered.has(key)) ok = false;
      covered.add(key);
    }
  }
  t.check('table cells tile the table', ok, name, () => `${table.rows}x${table.cols}`);
}

function checkTable(t, name, table) {
  const rec = table.childRecord(TAG.TABLE);
  const v = viewOf(rec.data);
  // Row sizes follow the 18-byte head of 표 75: attr, rows, cols, spacing, margins.
  let declared = 0;
  for (let i = 0; i < table.rows; i++) declared += v.getUint16(18 + 2 * i, true);
  t.check('table cell count = sum of row sizes', declared === table.cells.length, name, () => `${declared} vs ${table.cells.length}`);
  const covered = new Set();
  let ok = true;
  for (const c of table.cells) {
    if (c.colSpan < 1 || c.rowSpan < 1 || c.col + c.colSpan > table.cols || c.row + c.rowSpan > table.rows) { ok = false; break; }
    for (let r = c.row; r < c.row + c.rowSpan; r++) for (let k = c.col; k < c.col + c.colSpan; k++) {
      const key = r * 65536 + k;
      if (covered.has(key)) ok = false;
      covered.add(key);
    }
  }
  t.check('C5 cell addresses at byte 8 tile the table', ok, name, () => `${table.rows}x${table.cols}`);
}

let ok = true;
if (!kinds.length || kinds.includes('hwp5')) ok = (await checkHwp5()) && ok;
if (!kinds.length || kinds.includes('hwpx')) ok = (await checkHwpx()) && ok;
process.exitCode = ok ? 0 : 1;
