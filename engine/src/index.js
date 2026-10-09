// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Engine entry point: open a document of either format.

import { FormatError, UnsupportedError } from './util/bytes.js';
import { Hwp5Document } from './hwp5/document.js';
import { HwpxDocument } from './hwpx/document.js';

export { FormatError, UnsupportedError, Hwp5Document, HwpxDocument };
export { validate } from './validate.js';

export const ATTRIBUTION = '본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.';

/**
 * Open a .hwp (HWP 5.0) or .hwpx (OWPML) document from its bytes; the
 * format is recognised from the content, not the file name.
 * @param {Uint8Array} bytes
 */
export function openDocument(bytes) {
  if (Hwp5Document.sniff(bytes)) return new Hwp5Document(bytes);
  if (HwpxDocument.sniff(bytes)) return new HwpxDocument(bytes);
  // HWP 3.0 signature "HWP Document File V3.00 \x1a\1\2\3\4\5" (hwp3-hwpml §3.1 p.8).
  if (bytes.length >= 23 && new TextDecoder('latin1').decode(bytes.subarray(0, 23)) === 'HWP Document File V3.00') {
    throw new UnsupportedError('HWP 3.0 document (only HWP 5.0 and HWPX are supported)');
  }
  throw new FormatError('not an HWP 5.0 or HWPX document');
}

export { findSlots, fieldSpans } from './form/slots.js';
export { fillSlots, planFill, setSlotValue, SlotMatcher } from './form/fill.js';
export { documentOutline } from './form/outline.js';
export { applyTextEdits, textDiff, paragraphList } from './form/edit.js';
export { createZip } from './container/zipwrite.js';
export { normaliseLabel, DEFAULT_ALIASES } from './form/labels.js';
export { csvRecords, jsonRecords, decodeText, parseCsv } from './data/csv.js';

import { validate as validateDocument } from './validate.js';
import { findSlots as find } from './form/slots.js';
import { fillSlots as fill } from './form/fill.js';
import { applyTextEdits } from './form/edit.js';

/**
 * Fill one form with one record and return the new file. The output is
 * opened again and checked before it is returned; a check that fails on
 * the output but not on the input throws, so a damaged file is never
 * handed back.
 * @param {Uint8Array} bytes the form
 * @param {Record<string, string>} record column -> text
 * @param {object} [options] passed to fillSlots (aliases, lineSegs,
 *   markFieldsModified); rewriteAll re-encodes unchanged sections too;
 *   edits are changes to the form's own text (form/edit.js), applied
 *   after the slots are filled
 * @returns {Promise<{ bytes: Uint8Array, report: object, slots: object[], format: string }>}
 *   report.edits lists the text edits applied and failed
 */
export async function fillForm(bytes, record, options = {}) {
  const doc = openDocument(bytes);
  const before = new Set(validateDocument(doc));
  const slots = find(doc);
  const report = fill(slots, record, options);
  report.edits = applyTextEdits(doc, options.edits, options);
  const fresh = (problems) => problems.filter((p) => !before.has(p));
  let problems = fresh(validateDocument(doc));
  if (problems.length) throw new Error(`refusing to write a damaged document: ${problems.slice(0, 5).join('; ')}`);
  const changed = report.filled.length || report.edits.applied.length;
  const out = changed || options.rewriteAll ? await doc.toBytes({ rewriteAll: !!options.rewriteAll }) : bytes.slice();
  problems = fresh(validateDocument(openDocument(out)));
  if (problems.length) throw new Error(`refusing to write a damaged document: ${problems.slice(0, 5).join('; ')}`);
  return { bytes: out, report, slots, format: doc.format };
}
