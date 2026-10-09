// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// "브라우저에 임시저장": the open forms and what was put into them, kept in
// this browser's IndexedDB so that work goes on after the page is closed.
// Only when the user turns it on; turning it off deletes what was kept.
//
//   files: form key -> the form file as opened (bytes)
//   state: 'session' -> { savedAt, current, forms: [{ key, name, ... }] }

const DB = 'hankan';
const FLAG = 'hankan.autosave';

let dbPromise = null;

function db() {
  dbPromise ??= new Promise((ok, fail) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('files');
      req.result.createObjectStore('state');
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
    req.onblocked = () => fail(new Error('IndexedDB blocked'));
  }).catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await db();
  return new Promise((ok, fail) => {
    const tx = d.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    tx.oncomplete = () => ok(result?.result);
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error ?? new Error('transaction aborted'));
  });
}

export function autosaveWanted() {
  try { return localStorage.getItem(FLAG) === '1'; } catch { return false; }
}

export function setAutosaveWanted(on) {
  try {
    if (on) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG);
  } catch {
    // Without localStorage the choice lasts until the page is closed.
  }
}

export function saveFile(key, bytes) {
  return run('files', 'readwrite', (s) => s.put(bytes, key));
}

export function deleteFile(key) {
  return run('files', 'readwrite', (s) => s.delete(key));
}

export function saveSession(session) {
  return run('state', 'readwrite', (s) => s.put(session, 'session'));
}

/** @returns {Promise<{ session: object|null, files: Map<string, Uint8Array> }>} */
export async function loadAll() {
  const session = (await run('state', 'readonly', (s) => s.get('session'))) ?? null;
  const files = new Map();
  for (const f of session?.forms ?? []) {
    const bytes = await run('files', 'readonly', (s) => s.get(f.key));
    if (bytes) files.set(f.key, new Uint8Array(bytes));
  }
  return { session, files };
}

export async function clearAll() {
  await run('files', 'readwrite', (s) => s.clear());
  await run('state', 'readwrite', (s) => s.clear());
}
