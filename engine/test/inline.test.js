import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInlineBlanks } from '../src/form/inline.js';

/** A paragraph stand-in: text, with each tab as an 8-unit control as in HWP 5.0. */
function para(text) {
  const units = [];
  let pos = 0;
  for (const piece of text.split(/(\t)/)) {
    if (piece === '\t') { units.push({ type: 'control', pos, end: pos + 8, code: 9, kind: 'inline' }); pos += 8; continue; }
    if (piece) { units.push({ type: 'text', pos, end: pos + piece.length, text: piece }); pos += piece.length; }
  }
  units.push({ type: 'end', pos, end: pos + 1 });
  const flat = [];
  for (const u of units) if (u.type === 'text') for (let i = 0; i < u.text.length; i++) flat[u.pos + i] = u.text[i];
  return { units: () => units, controls: [], slice: (a, b) => flat.slice(a, b).join('') };
}

function blanks(text) {
  const p = para(text);
  return findInlineBlanks(p).map((b) => `${b.kind}:${b.display.join('/')}${b.lead ? '@' + b.lead : ''}:${b.parts.map((x) => x.role + '=' + JSON.stringify(p.slice(x.start, x.end))).join(',')}`);
}

const CASES = [
  ['신청인      (성명)             (주민등록번호         -          )', ['split:주민등록번호@신청인:part="         ",part="          "', 'text:성명@신청인:value="             "']],
  ['            (주소)', ['append:주소:value=""']],
  ['20  .   .    .', ['date::year="  ",month="   ",day="    "']],
  ['신고연월일\t20   년     월     일\t\t', ['date::year="   ",month="     ",day="     "']],
  ['작성일:     년     월     일', ['date:작성일:year="     ",month="     ",day="     "']],
  ['2024년   월   일', ['date::month="   ",day="   "']],
  ['등록기준지:    ', ['text:등록기준지:value="    "']],
  ['주      소:    ', ['text:주소:value="    "']],
  ['               작성자 :              (서명)', ['text:작성자:value="              "']],
  ['             위 제출인 :          (인)    ', ['text:제출인:value="          "']],
  ['          지 원 자 :                       (인)', ['text:지원자:value="                       "']],
  ['신청인(전세사기피해자)                    (서명 또는 날인)', ['text:신청인:value="                    "']],
  ['청 구 인:                    (연락 가능한 전화번호:                            ) ', ['text:청구인:value="                    "', 'text:연락 가능한 전화번호:value="                            "']],
  ['              (생년월일:               )', ['text:생년월일:value="               "']],
  ['물 □전자파일 □복제․인화물 □기타(     )', ['text:기타:value="     "']],
  ['전화번호(               )', ['text:전화번호:value="               "']],
  ['배당 시 송금받을           은행            지점   계좌번호                ', ['text:은행:value="           "', 'text:지점:value="            "', 'text:계좌번호:value="                "']],
  ['    은행            지점   계좌번호                ', ['text:은행:value="    "', 'text:지점:value="            "', 'text:계좌번호:value="                "']],
  ['제        호', ['text:제호:value="        "']],
  ['    시간', ['text:시간:value="    "']],
  ['항소인(원,피고)     성명:               ', ['text:성명@항소인:value="               "']],
  ['성  명 :                                (주민등록번호 :               -               )', ['split:주민등록번호:part="               ",part="               "', 'text:성명:value="                                "']],
  [' 확인일 :           , 확인자 : (직급)            (성명)                (날인)', ['text:확인일:value="           "', 'text:직급:value="            "', 'text:성명:value="                "']],
  ['보증금             원', ['text:보증금/원:value="             "']],
  ['       년     월     일부터      년      월      일까지', ['date:부터:year="       ",month="     ",day="     "', 'date:까지:year="      ",month="      ",day="      "']],
  ['성     명:                     주민등록번호:            - ', ['split:주민등록번호:part="            ",part=" "', 'text:성명:value="                     "']],
  // Layout, not blanks:
  ['(반명함판)', []],
  ['            (뒤쪽)', []],
  ['⑤  ', []],
  ['위     임     장', []],
  ['원    금', []],
  ['□ 있음       □ 없음', []],
  ['          (서명 또는 날인)            ', []],
  ['   본인은 위 사람을 대리인으로 정하여 ', []],
  ['납부하고 영수증을 첨부하여야 합니다.   ', []],
  ['생년월일', []],
  ['2020년 1월 1일', []],
  ['     2. 증빙서류             ', []],
  ['            ※ 기재 공간이 부족한 경우 별첨으로', []],
];

for (const [text, want] of CASES) {
  test(`blanks in ${JSON.stringify(text)}`, () => assert.deepEqual(blanks(text), want));
}
