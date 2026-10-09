// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Glyph widths (em) measured from render batches by tools/render/calibrate.py
// (`--write` rewrites the two tables below). Classes as in width.js; 'space'
// is the standard space, 'fontSpace' the font's own space, used when a
// character shape asks for it.
//
// BASE holds the widths common to the fonts measured; MEASURED holds, per
// face name as written in documents, only the widths that differ from BASE.

export const BASE = {"digit": 0.55, "hangul": 0.971, "lower": 0.602, "punct": 0.55, "space": 0.5};
export const MEASURED = {
  "굴림": {
    "digit": 0.58,
    "hangul": 1.002,
    "lower": 0.574,
    "punct": 0.59
  },
  "돋움": {
    "digit": 0.585,
    "hangul": 1.0,
    "lower": 0.58,
    "punct": 0.59
  },
  "맑은 고딕": {
    "hangul": 1.002,
    "lower": 0.551,
    "punct": 0.412
  }
};
