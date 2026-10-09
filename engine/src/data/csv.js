// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Reading the user's data: CSV (RFC 4180) and JSON. Generic.

/**
 * Decode a text file: UTF-8 (with or without a byte order mark), else
 * CP949/EUC-KR, which is what spreadsheet programs on Korean systems
 * write by default.
 */
export function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('euc-kr').decode(bytes);
  }
}

/** Parse CSV text into rows of fields. Quoted fields may hold separators, quotes ("") and newlines. */
export function parseCsv(text, delimiter = guessDelimiter(text)) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function guessDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch) => first.split(ch).length - 1;
  return count('\t') > count(',') ? '\t' : count(';') > count(',') ? ';' : ',';
}

/** CSV with a header row → array of { column: value } records. */
export function csvRecords(text, delimiter) {
  const rows = parseCsv(text.replace(/^﻿/, ''), delimiter);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  const seen = new Set();
  for (const h of header) {
    if (h && seen.has(h)) throw new Error(`CSV header repeats the column "${h}"`);
    seen.add(h);
  }
  return rows.slice(1).map((r) => {
    const rec = {};
    header.forEach((h, k) => { if (h) rec[h] = r[k] ?? ''; });
    return rec;
  });
}

/** JSON data: one object, or an array of objects; values are turned into text. */
export function jsonRecords(text) {
  const data = JSON.parse(text.replace(/^﻿/, ''));
  const list = Array.isArray(data) ? data : [data];
  return list.map((o, i) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`JSON record ${i + 1} is not an object`);
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]));
  });
}
