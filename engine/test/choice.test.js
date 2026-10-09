import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChoiceLines, chooseOptions } from '../src/form/choice.js';

function para(text) {
  const units = [{ type: 'text', pos: 0, end: text.length, text }, { type: 'end', pos: text.length, end: text.length + 1 }];
  return { units: () => units, controls: [] };
}
const lines = (text) => findChoiceLines(para(text)).map((l) => `${l.label ?? ''}|${l.options.map((o) => o.label).join(',')}${l.item ? '|item' : ''}`);

const CASES = [
  ['□ 있음       □ 없음', ['|있음,없음']],
  ['□신입 □경력', ['|신입,경력']],
  ['지원구분: □신입 □경력', ['지원구분|신입,경력']],
  ['   해당없음□ / 저소득층□ / 장애인□ / 장기실직자□ /', ['|해당없음,저소득층,장애인,장기실직자']],
  ['필수적 정보 (동의함 ☐ 동의하지 않음 ☐)', ['필수적 정보|동의함,동의하지 않음']],
  ['수도/강원 ☐,영남 ☐, 충청/전라/제주 ☐', ['|수도/강원,영남,충청/전라/제주']],
  ['□ 통합송달(주간+야간+휴일)  □ 주간송달', ['|통합송달(주간+야간+휴일),주간송달']],
  [' □ 주소 변동 없음', ['|주소 변동 없음|item']],
  ['■ 신규 □ 변경', ['|신규,변경']],
  ['□ 보훈대상(10%) □ 보훈대상(5%) □ 장애대상(5%)', ['|보훈대상(10%),보훈대상(5%),장애대상(5%)']],
  [' □ 진료실   □ 정액채취실   □ 기타 (                                     )  ', ['|진료실,정액채취실,기타']],
  ['수입은 월         원(□ 세금 공제 전 / □ 세금 공제 후)이고', ['|세금 공제 전,세금 공제 후']],
  ['[  ] 있음  [  ] 없음', ['|있음,없음']],
  ['[  ] 매도   [  ] 임대   [  ] 그 밖의 사항(                                 )', ['|매도,임대,그 밖의 사항']],
  ['[  ]소화설비', ['|소화설비|item']],
  ['남(  ),여(  )  ', ['|남,여']],
  ['   █ 재산관리인 후보자는 위 내용을 확인하였습니까?  예 (    )    아니요 (    )    ', ['|예,아니요']],
  ['영상 [ ]', ['|영상']],
  ['[√] 동의함  [  ] 동의하지 않음', ['|동의함,동의하지 않음']],
  // Not check boxes:
  ['※ [  ]에는 해당되는 곳에 √표를 합니다.', []],
  ['1. 수탁처리능력 확인 시에는 해당 [ ]에 표시를 하고 (1)란부터', []],
  ['□ 기타(     )', ['|기타|item']],
  ['            (서명 또는 날인)', []],
  [' □□□-□□□', []],
  ['□ 경력 사항 : 지원한 직무와 관련한 경력(금전적 보수받고 4대보험 가입된 상태로 근무)', []],
  ['1. 상대방의 주소가 변동되지 않은 경우에는 주소변동 없음난의 □에 “✔” 표시를 하고, 송달이 가능한', []],
  ['■ 작성 요령', []],
];
for (const [text, want] of CASES) test(`check boxes in ${JSON.stringify(text)}`, () => assert.deepEqual(lines(text), want));

test('values choose options', () => {
  const opts = (...ls) => ls.map((label) => ({ label }));
  assert.deepEqual(chooseOptions(opts('있음', '없음'), '없음').map((o) => o.label), ['없음']);
  assert.deepEqual(chooseOptions(opts('우편', '팩스', '전자우편'), '우편, 전자우편').map((o) => o.label), ['우편', '전자우편']);
  assert.deepEqual(chooseOptions(opts('통합송달', '주간송달'), '통합').map((o) => o.label), ['통합송달']);
  assert.deepEqual(chooseOptions(opts('주소 변동 없음'), 'Y').map((o) => o.label), ['주소 변동 없음']);
  assert.deepEqual(chooseOptions(opts('주소 변동 없음'), 'N'), []);
  assert.throws(() => chooseOptions(opts('있음', '없음'), '모름'), RangeError);
  assert.throws(() => chooseOptions(opts('보훈대상(10%)', '보훈대상(5%)'), '보훈'), RangeError);
  assert.deepEqual(chooseOptions(opts('보훈대상(10%)', '보훈대상(5%)'), '보훈대상(5%)').map((o) => o.label), ['보훈대상(5%)']);
  assert.deepEqual(chooseOptions(opts('피고의 소득 활동/특별한 수익', '피고의 재산관리'), '피고의 소득 활동/특별한 수익').map((o) => o.label), ['피고의 소득 활동/특별한 수익']);
});
