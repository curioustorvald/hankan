// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Label text: normalising the words printed next to a blank so that
// "성 명", "성\u3000명:" and "(성명)" all read as 성명, and matching them with
// the column names of the user's data. Generic text processing; no
// knowledge of the file formats.

/** Normalise label or column text for comparison. */
export function normaliseLabel(text) {
  return text
    .normalize('NFC')
    .replace(/[\s\u3000\u00a0]+/g, '')        // all spacing, including ideographic space
    .replace(/^[*※·•▪□■○●◦◎\-–—]+/, '')       // bullets and note marks in front
    .replace(/[:：.。]+$/, '')                  // a trailing colon or full stop
    .replace(/^[(（[［<〈「『](.*)[)）\]］>〉」』]$/, '$1') // a label wrapped in brackets
    .toLowerCase();
}

/**
 * Whether cell text reads like a label for a neighbouring blank: short,
 * not a note or instruction, and not a sentence.
 */
export function looksLikeLabel(text) {
  const t = text.trim();
  if (!t) return false;
  if (/^[*※]/.test(t)) return false;                 // notes
  const n = normaliseLabel(t);
  if (!n || n.length > 24) return false;
  if (/[.?!。]$/.test(t) && n.length > 12) return false; // sentences
  if (/^[\d\s.,~\-:/()]+$/.test(t)) return false;     // numbers, dates, placeholders like 0000.00.00
  return true;
}

/**
 * Groups of words that mean the same thing on Korean forms. A column named
 * by any member matches a label equal to any other member. Users can pass
 * their own groups; these are only a starting set.
 */
export const DEFAULT_ALIASES = [
  ['성명', '이름', '성함', '이름(한글)', '성명(한글)'],
  ['영문성명', '성명(영문)', '영문이름', '이름(영문)'],
  ['생년월일', '출생일', '생일'],
  ['주민등록번호', '주민번호'],
  ['주소', '주소지', '거주지', '현주소'],
  ['전화번호', '전화', '연락처'],
  ['휴대전화', '휴대폰', '휴대전화번호', '핸드폰', '휴대폰번호', '이동전화'],
  ['전자우편', '이메일', 'e-mail', 'email', '전자우편주소', '전자우편(이메일)'],
  ['소속', '소속기관', '근무처', '직장'],
  ['직위', '직급', '직책', '직급(직위)'],
  ['날짜', '작성일', '작성일자', '신청일', '신청일자', '제출일', '제출일자', '일자', '연월일', '년월일'],
];

/**
 * Labels naming the person filling the form. As an outer label they add
 * nothing: under 신청인, "성명" is still the user's own name.
 */
export const SELF_PARTIES = ['신청인', '신청자', '신고인', '청구인', '지원자', '응시자', '본인', '작성자', '민원인', '제출자'];

/**
 * Words marking a section about someone other than the user. A bare column
 * such as "성명" never fills a slot under such a label or section; it must be
 * named in full ("대리인.성명").
 */
export const OTHER_PARTY = /대리인|배우자|보호자|위임|수임|피신청인|상대방|피고|채무자|보증인|추천인|부모|가족|동거인|세대원|증인|자녀|법정대리|담당자|확인자|대표자/;

export function aliasIndex(groups = DEFAULT_ALIASES) {
  const index = new Map();
  for (const group of groups) {
    const norm = group.map(normaliseLabel);
    for (const w of norm) {
      const set = index.get(w) ?? new Set();
      for (const o of norm) set.add(o);
      index.set(w, set);
    }
  }
  return index;
}
