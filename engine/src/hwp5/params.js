// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Parameter sets (hwp5 §4.2.12 표 50–52 p.31), used by HWPTAG_DOC_DATA and
// HWPTAG_CTRL_DATA (hwp5 §4.3.8 표 66 p.36; it holds a control's field name).
//
// Corpus observation (PROVENANCE.md, "C2"): in the CTRL_DATA of fields,
// the parameter item id is stored as 4 bytes, not as the WORD of 표 51;
// with a WORD id no field's item would have a valid type. The item layout
// read here is therefore: UINT32 id, WORD type, data. It is only used for
// fields; other controls' CTRL_DATA is never read.

import { FormatError, Reader } from '../util/bytes.js';

export const PIT = Object.freeze({
  NULL: 0, BSTR: 1, I1: 2, I2: 3, I4: 4, I: 5, UI1: 6, UI2: 7, UI4: 8, UI: 9,
  SET: 0x8000, ARRAY: 0x8001, BINDATA: 0x8002,
});

/** @returns {{ id: number, items: Array<{ id: number, type: number, value: any }> }} */
export function parseParameterSet(r, depth = 0) {
  if (depth > 16) throw new FormatError('parameter set nested too deeply');
  const id = r.u16();
  const count = r.i16();
  const items = [];
  for (let i = 0; i < count; i++) {
    const itemId = r.u32();
    const type = r.u16();
    items.push({ id: itemId, type, value: readItem(r, type, depth) });
  }
  return { id, items };
}

function readItem(r, type, depth) {
  switch (type) {
    case PIT.NULL: return r.u32();
    case PIT.BSTR: return r.utf16(r.u16());
    case PIT.I1: case PIT.I2: case PIT.I4: case PIT.I: return r.i32();
    case PIT.UI1: case PIT.UI2: case PIT.UI4: case PIT.UI: return r.u32();
    case PIT.SET: return parseParameterSet(r, depth + 1);
    case PIT.ARRAY: {
      const n = r.i16();
      const sets = [];
      for (let i = 0; i < n; i++) sets.push(parseParameterSet(r, depth + 1));
      return sets;
    }
    case PIT.BINDATA: return r.u16();
    default: throw new FormatError(`parameter item type ${type}`);
  }
}

/** The first BSTR item of a CTRL_DATA parameter set, or null. */
export function firstString(data) {
  try {
    const set = parseParameterSet(new Reader(data));
    const item = set.items.find((it) => it.type === PIT.BSTR);
    return item ? item.value : null;
  } catch {
    return null;
  }
}
