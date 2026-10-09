// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Form objects (HWPTAG_FORM_OBJECT, "양식 개체", hwp5 표 57): only check
// boxes and radio buttons, and only their caption and checked state.
//
// The spec names this record but does not describe its contents. Its layout
// was derived from the corpus (PROVENANCE.md, C11): the 103 form-object
// records of the 8 corpus documents that have any were displayed as hex and
// text, and all have the same framing:
//
//   4 bytes     type tag, ASCII: "tbc+" check box, "tbr+" radio button
//   4 bytes     the same tag again
//   UINT32      n, length of the text in UTF-16 units
//   WORD        n again
//   WCHAR[n]    property text
//
// The property text uses the syntax KS X 6101 §10.7.3.1 shows for a field
// command ("Clickhere:set:66:Direction:wstring:23:..."): items separated by
// a space, each "Name:type:value"; a wstring is "Name:wstring:len:chars", a
// set "Name:set:len:items". The names are those of the form-object
// attributes in owpml-ksx6101 §10.11 (Name, GroupName, Caption, Value, ...).
// The checked state is "Value:int:N"; OWPML lists its values as UNCHECKED,
// CHECKED, INDETERMINATE, read here as 0, 1, 2 (render batch 005 checks 1).
// tools/check/corpus.js verifies the framing and syntax on every record.

import { FormatError, viewOf } from '../util/bytes.js';

const TYPE = { 'tbc+': 'check', 'tbr+': 'radio' };

/** Parse the property text into a tree; each item keeps the offset of its value. */
export function parseProperties(text, base = 0) {
  const items = [];
  let i = 0;
  const fail = (m) => { throw new FormatError(`form object properties: ${m} at ${base + i}`); };
  while (i < text.length) {
    if (text[i] === ' ') { i++; continue; }
    const c1 = text.indexOf(':', i);
    const c2 = c1 < 0 ? -1 : text.indexOf(':', c1 + 1);
    if (c1 < 0 || c2 < 0) fail('item without type');
    const name = text.slice(i, c1);
    const type = text.slice(c1 + 1, c2);
    let j = c2 + 1;
    if (type === 'set' || type === 'wstring') {
      const c3 = text.indexOf(':', j);
      const n = Number(text.slice(j, c3));
      if (c3 < 0 || !Number.isInteger(n) || c3 + 1 + n > text.length) fail(`bad ${type} length`);
      const body = text.slice(c3 + 1, c3 + 1 + n);
      items.push(type === 'set'
        ? { name, type, start: base + c3 + 1, value: parseProperties(body, base + c3 + 1) }
        : { name, type, start: base + c3 + 1, value: body });
      i = c3 + 1 + n;
    } else {
      let k = j;
      while (k < text.length && text[k] !== ' ') k++;
      items.push({ name, type, start: base + j, value: text.slice(j, k) });
      i = k;
    }
  }
  return items;
}

function find(items, name) {
  for (const it of items) {
    if (it.name === name) return it;
    if (it.type === 'set') { const f = find(it.value, name); if (f) return f; }
  }
  return null;
}

/** Read a FORM_OBJECT record: { tag, type, text, items }. */
export function readFormObject(data) {
  if (data.length < 14) throw new FormatError('form object record too short');
  const v = viewOf(data);
  const tag = String.fromCharCode(...data.subarray(0, 4));
  const n = v.getUint32(8, true);
  if (String.fromCharCode(...data.subarray(4, 8)) !== tag || v.getUint16(12, true) !== n || 14 + 2 * n !== data.length) {
    throw new FormatError('form object record: unexpected framing');
  }
  let text = '';
  for (let k = 0; k < n; k++) text += String.fromCharCode(v.getUint16(14 + 2 * k, true));
  return { tag, type: TYPE[tag] ?? null, text, items: parseProperties(text) };
}

/** The form object control of a paragraph, for the check boxes and radio buttons it can mark. */
export class FormObjectInfo {
  /** @param {import('./records.js').Record} rec the FORM_OBJECT record */
  constructor(rec) {
    this.rec = rec;
    const f = readFormObject(rec.data);
    this.formType = f.type;
    this.caption = (find(f.items, 'Caption')?.value ?? '').trim();
    const value = find(f.items, 'Value');
    this.valueItem = value;
    this.checked = value ? Number(value.value) === 1 : false;
  }

  /** Set the checked state, rewriting only the digit of "Value:int:N". */
  setChecked(on) {
    const item = this.valueItem;
    if (!item || item.type !== 'int' || item.value.length !== 1) throw new RangeError('form object: no single-digit Value to set');
    const data = this.rec.data.slice();
    viewOf(data).setUint16(14 + 2 * item.start, (on ? '1' : '0').charCodeAt(0), true);
    this.rec.setData(data);
    item.value = on ? '1' : '0';
    this.checked = on;
  }
}
