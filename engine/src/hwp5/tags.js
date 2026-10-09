// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Record tag ids and control ids of HWP 5.0.
// Source: hwp5 §4.1 p.16 (HWPTAG_BEGIN), 표 13 p.17 (DocInfo tags),
// 표 57 p.33 (BodyText tags), 표 67 p.37, 표 127 p.52 and 표 128 p.52–53
// (control ids), MAKE_4CHID in §4.3.9 p.36.

export const HWPTAG_BEGIN = 0x010;

/** DocInfo record tags (hwp5 표 13). */
export const DOCINFO = Object.freeze({
  DOCUMENT_PROPERTIES: HWPTAG_BEGIN,
  ID_MAPPINGS: HWPTAG_BEGIN + 1,
  BIN_DATA: HWPTAG_BEGIN + 2,
  FACE_NAME: HWPTAG_BEGIN + 3,
  BORDER_FILL: HWPTAG_BEGIN + 4,
  CHAR_SHAPE: HWPTAG_BEGIN + 5,
  TAB_DEF: HWPTAG_BEGIN + 6,
  NUMBERING: HWPTAG_BEGIN + 7,
  BULLET: HWPTAG_BEGIN + 8,
  PARA_SHAPE: HWPTAG_BEGIN + 9,
  STYLE: HWPTAG_BEGIN + 10,
  DOC_DATA: HWPTAG_BEGIN + 11,
  DISTRIBUTE_DOC_DATA: HWPTAG_BEGIN + 12,
  COMPATIBLE_DOCUMENT: HWPTAG_BEGIN + 14,
  LAYOUT_COMPATIBILITY: HWPTAG_BEGIN + 15,
  TRACKCHANGE: HWPTAG_BEGIN + 16,
  MEMO_SHAPE: HWPTAG_BEGIN + 76,
  FORBIDDEN_CHAR: HWPTAG_BEGIN + 78,
  TRACK_CHANGE: HWPTAG_BEGIN + 80,
  TRACK_CHANGE_AUTHOR: HWPTAG_BEGIN + 81,
});

/** BodyText record tags (hwp5 표 57). */
export const TAG = Object.freeze({
  PARA_HEADER: HWPTAG_BEGIN + 50,
  PARA_TEXT: HWPTAG_BEGIN + 51,
  PARA_CHAR_SHAPE: HWPTAG_BEGIN + 52,
  PARA_LINE_SEG: HWPTAG_BEGIN + 53,
  PARA_RANGE_TAG: HWPTAG_BEGIN + 54,
  CTRL_HEADER: HWPTAG_BEGIN + 55,
  LIST_HEADER: HWPTAG_BEGIN + 56,
  PAGE_DEF: HWPTAG_BEGIN + 57,
  FOOTNOTE_SHAPE: HWPTAG_BEGIN + 58,
  PAGE_BORDER_FILL: HWPTAG_BEGIN + 59,
  SHAPE_COMPONENT: HWPTAG_BEGIN + 60,
  TABLE: HWPTAG_BEGIN + 61,
  SHAPE_COMPONENT_LINE: HWPTAG_BEGIN + 62,
  SHAPE_COMPONENT_RECTANGLE: HWPTAG_BEGIN + 63,
  SHAPE_COMPONENT_ELLIPSE: HWPTAG_BEGIN + 64,
  SHAPE_COMPONENT_ARC: HWPTAG_BEGIN + 65,
  SHAPE_COMPONENT_POLYGON: HWPTAG_BEGIN + 66,
  SHAPE_COMPONENT_CURVE: HWPTAG_BEGIN + 67,
  SHAPE_COMPONENT_OLE: HWPTAG_BEGIN + 68,
  SHAPE_COMPONENT_PICTURE: HWPTAG_BEGIN + 69,
  SHAPE_COMPONENT_CONTAINER: HWPTAG_BEGIN + 70,
  CTRL_DATA: HWPTAG_BEGIN + 71,
  EQEDIT: HWPTAG_BEGIN + 72,
  SHAPE_COMPONENT_TEXTART: HWPTAG_BEGIN + 74,
  FORM_OBJECT: HWPTAG_BEGIN + 75,
  MEMO_SHAPE: HWPTAG_BEGIN + 76,
  MEMO_LIST: HWPTAG_BEGIN + 77,
  CHART_DATA: HWPTAG_BEGIN + 79,
  VIDEO_DATA: HWPTAG_BEGIN + 82,
  SHAPE_COMPONENT_UNKNOWN: HWPTAG_BEGIN + 99,
});

export const TAG_NAME = Object.freeze(Object.fromEntries([
  ...Object.entries(DOCINFO).map(([k, v]) => [v, k]),
  ...Object.entries(TAG).map(([k, v]) => [v, k]),
]));

/** MAKE_4CHID(a, b, c, d) = (a << 24) | (b << 16) | (c << 8) | d (hwp5 §4.3.9 p.36). */
export function ctrlId(s) {
  return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
}

export function ctrlIdString(id) {
  return String.fromCharCode((id >>> 24) & 0xff, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff);
}

/** Control ids (hwp5 표 67, 표 127). */
export const CTRL = Object.freeze({
  TABLE: ctrlId('tbl '),
  LINE: ctrlId('$lin'),
  RECT: ctrlId('$rec'),
  ELLIPSE: ctrlId('$ell'),
  ARC: ctrlId('$arc'),
  POLYGON: ctrlId('$pol'),
  CURVE: ctrlId('$cur'),
  EQUATION: ctrlId('eqed'),
  PICTURE: ctrlId('$pic'),
  OLE: ctrlId('$ole'),
  CONTAINER: ctrlId('$con'),
  SECTION_DEF: ctrlId('secd'),
  COLUMN_DEF: ctrlId('cold'),
  HEADER: ctrlId('head'),
  FOOTER: ctrlId('foot'),
  FOOTNOTE: ctrlId('fn  '),
  ENDNOTE: ctrlId('en  '),
  AUTO_NUMBER: ctrlId('atno'),
  NEW_NUMBER: ctrlId('nwno'),
  PAGE_HIDE: ctrlId('pghd'),
  PAGE_ODD_EVEN: ctrlId('pgct'),
  PAGE_NUMBER_POS: ctrlId('pgnp'),
  INDEX_MARK: ctrlId('idxm'),
  BOOKMARK: ctrlId('bokm'),
  OVERLAP: ctrlId('tcps'),
  DUTMAL: ctrlId('tdut'),
  HIDDEN_COMMENT: ctrlId('tcmt'),
});

/** Field control ids (hwp5 표 128). Every field id starts with '%'. */
export const FIELD = Object.freeze({
  UNKNOWN: ctrlId('%unk'),
  DATE: ctrlId('%dte'),
  DOCDATE: ctrlId('%ddt'),
  PATH: ctrlId('%pat'),
  BOOKMARK: ctrlId('%bmk'),
  MAILMERGE: ctrlId('%mmg'),
  CROSSREF: ctrlId('%xrf'),
  FORMULA: ctrlId('%fmu'),
  CLICKHERE: ctrlId('%clk'),
  SUMMARY: ctrlId('%smr'),
  USERINFO: ctrlId('%usr'),
  HYPERLINK: ctrlId('%hlk'),
  MEMO: ctrlId('%%me'),
  PRIVATE_INFO_SECURITY: ctrlId('%cpr'),
  TABLEOFCONTENTS: ctrlId('%toc'),
});

export function isFieldCtrl(id) {
  return id >>> 24 === 0x25; // '%'
}
