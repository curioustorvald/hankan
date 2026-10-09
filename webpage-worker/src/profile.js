// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// "내 정보": name/value rows the user keeps for every form. Kept in this
// browser's localStorage only when the user asks for it.

const KEY = 'hankan.profile';
const STARTER = ['성명', '생년월일', '주소', '휴대폰', '이메일'];

export function loadProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (Array.isArray(saved?.rows)) return { remember: true, rows: saved.rows.map((r) => ({ name: String(r.name ?? ''), value: String(r.value ?? '') })) };
  } catch {
    // Storage blocked or unreadable: start empty.
  }
  return { remember: false, rows: STARTER.map((name) => ({ name, value: '' })) };
}

export function saveProfile(profile) {
  try {
    if (profile.remember) localStorage.setItem(KEY, JSON.stringify({ rows: profile.rows }));
    else localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

/** The rows as a record (name -> value), leaving out empty ones. */
export function profileRecord(profile) {
  const record = {};
  for (const { name, value } of profile.rows) {
    if (name.trim() && value.trim()) record[name.trim()] = value.trim();
  }
  return record;
}
