// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// The webapp: open forms, show them with inputs at their slots, and hand
// back filled files. Everything happens in this page; files are never sent
// anywhere. The engine (engine/src, copied in at build time) does all
// reading and writing of documents.

import {
  openDocument, findSlots, documentOutline, planFill, fillForm, createZip,
  csvRecords, jsonRecords, decodeText, UnsupportedError, FormatError,
} from './engine/index.js';
import { chooseOptions } from './engine/form/choice.js';
import { renderOutline, refreshInputs, readText, editKey, paint, PLAIN_EDITING } from './render.js';
import { loadProfile, saveProfile, profileRecord } from './profile.js';
import { autosaveWanted, setAutosaveWanted, saveFile, deleteFile, saveSession, loadAll, clearAll } from './storage.js';

const $ = (id) => document.getElementById(id);
const FORMAT_NAME = { hwp5: 'HWP 5.0', hwpx: 'HWPX' };

/**
 * An open form. `text` and `picks` hold only what differs from the file:
 * slot id -> text, and choice slot id -> Set of option indices.
 * `source` says where a value came from ('manual' or 'profile').
 * `edits` holds changes to the form's own text (editing mode): "p:start:end"
 * -> { p, start, end, from, to }; `stretches` are the editable stretches.
 */
const forms = [];
let current = null;
let editing = false;
let nextId = 1;
const profile = loadProfile();
let batch = null; // { file, records, columns }
let busy = false;

// ---- opening ---------------------------------------------------------------

const PROBLEM = [
  [/password|encrypted/i, '암호가 걸린 문서입니다.'],
  [/distribution/i, '배포용 문서는 고칠 수 없습니다.'],
  [/DRM/i, '보호된(DRM) 문서입니다.'],
  [/HWP 3\.0/, 'HWP 3.0 문서는 지원하지 않습니다.'],
];

function explain(e) {
  if (e instanceof UnsupportedError) {
    const hit = PROBLEM.find(([re]) => re.test(e.message));
    return hit ? hit[1] : `지원하지 않는 문서입니다. (${e.message})`;
  }
  if (e instanceof FormatError) return '.hwp·.hwpx 문서가 아니거나 손상된 파일입니다.';
  return `열지 못했습니다. (${e.message})`;
}

const newKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function makeForm(name, bytes, key = newKey()) {
  const doc = openDocument(bytes);
  const slots = findSlots(doc);
  const form = {
    id: nextId++, key, name, bytes, format: doc.format, doc, slots,
    byId: new Map(slots.map((s) => [s.id, s])),
    outline: documentOutline(doc, slots),
    text: new Map(), picks: new Map(), source: new Map(),
    edits: new Map(), stretches: new Map(),
    report: null,
  };
  const visit = (blocks) => {
    for (const b of blocks) {
      if (b.type === 'p') for (const x of b.segments) if (x.p !== undefined) form.stretches.set(editKey(x), x);
      if (b.type === 'table') for (const c of b.cells) visit(c.blocks);
    }
  };
  visit(form.outline);
  // A box whose label can't be told apart from its neighbours' can't be
  // asked for by name, so it isn't offered.
  for (const s of slots) {
    if (s.kind !== 'choice' || s.options.length === 1) continue;
    s._unaddressable = new Set();
    s._options.forEach((o, i) => {
      let ok = !!o.label.trim() && !/[,;|]|\s\/|\/\s/.test(o.label);
      try { ok &&= chooseOptions(s._options, o.label)[0] === o; } catch { ok = false; }
      if (!ok) s._unaddressable.add(i);
    });
  }
  return form;
}

async function openFiles(files) {
  const opened = [];
  const problems = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const form = makeForm(file.name, bytes);
      forms.push(form);
      opened.push(form);
      if (autosave) saveFile(form.key, bytes).catch(autosaveFailed);
    } catch (e) {
      problems.push(`${file.name}: ${explain(e)}`);
    }
  }
  if (opened.length) {
    const { count } = applyProfile(opened);
    select(opened[0]);
    const slots = opened.reduce((n, f) => n + f.slots.length, 0);
    const msg = opened.length === 1 ? `${opened[0].name}: 채울 곳 ${slots}개` : `양식 ${opened.length}개, 채울 곳 ${slots}개`;
    toast(count ? `${msg} · 내 정보로 ${count}곳을 채웠습니다.` : msg);
  }
  if (problems.length) toast(problems.join('\n'), { error: true, long: true });
  renderList();
}

function closeForm(form) {
  if (filledCount(form) && !confirm(`${form.name}에 채운 내용이 사라집니다. 닫을까요?`)) return;
  forms.splice(forms.indexOf(form), 1);
  if (autosave) deleteFile(form.key).catch(autosaveFailed);
  if (current === form) select(forms[0] ?? null);
  renderList();
}

// ---- values ------------------------------------------------------------------

function choiceValue(slot, picks) {
  const fresh = [...picks].filter((i) => !slot._options[i].checked);
  if (!fresh.length) return '';
  if (slot.options.length === 1) return 'Y';
  return fresh.map((i) => slot.options[i]).join(', ');
}

/** What the user asked for in a form, as a record keyed by slot id. */
function recordOf(form) {
  const record = {};
  for (const [id, v] of form.text) record[id] = v;
  for (const [id, picks] of form.picks) {
    const v = choiceValue(form.byId.get(id), picks);
    if (v) record[id] = v;
  }
  return record;
}

function filledCount(form) {
  return Object.keys(recordOf(form)).length + form.edits.size;
}

function editsOf(form) {
  return [...form.edits.values()];
}

function setEdit(form, key, to) {
  const x = form.stretches.get(key);
  if (!x) return;
  if (to === x.text) form.edits.delete(key);
  else form.edits.set(key, { p: x.p, start: x.start, end: x.end, from: x.text, to });
}

function clearValue(form, id) {
  form.text.delete(id);
  form.picks.delete(id);
  form.source.delete(id);
}

/**
 * Put the profile into forms, leaving alone what was typed by hand. Values
 * the profile put in earlier are taken out first, so applying again after
 * changing the profile replaces them.
 */
function applyProfile(targets) {
  const record = profileRecord(profile);
  const used = new Set();
  let count = 0;
  for (const form of targets) {
    for (const [id, src] of [...form.source]) if (src === 'profile') clearValue(form, id);
    const { plan } = planFill(form.slots, record);
    for (const [slot, { column, value }] of plan) {
      if (form.source.get(slot.id) === 'manual') continue;
      if (slot.kind === 'choice') {
        let picked;
        try { picked = chooseOptions(slot._options, value); } catch { continue; }
        if (!picked.length) continue;
        form.picks.set(slot.id, new Set(picked.map((o) => slot._options.indexOf(o))));
      } else {
        form.text.set(slot.id, value);
      }
      form.source.set(slot.id, 'profile');
      used.add(column);
      count++;
    }
  }
  return { count, unused: Object.keys(record).filter((k) => !used.has(k)) };
}

// ---- showing a form ------------------------------------------------------------

function select(form) {
  current = form;
  $('welcome').hidden = !!form;
  $('form-view').hidden = !form;
  if (form) {
    $('form-title').textContent = form.name;
    renderOutline($('outline'), form.outline, form, { editing });
    for (const el of $('outline').querySelectorAll('textarea')) fitRows(el);
    showReport(form);
  }
  updateStats();
  renderList();
}

function updateStats() {
  if (!current) return;
  const f = current;
  const filled = filledCount(f) - f.edits.size;
  const parts = [FORMAT_NAME[f.format] ?? f.format, `채울 곳 ${f.slots.length}개`, `채운 곳 ${filled}개`];
  if (f.edits.size) parts.push(`고친 글자 ${f.edits.size}곳`);
  $('form-stats').textContent = parts.join(' · ');
  const li = document.querySelector(`#form-list [data-form="${f.id}"] .count`);
  if (li) li.textContent = `${filledCount(f)}/${f.slots.length}`;
  scheduleSave();
}

function showReport(form) {
  const box = $('report');
  const lines = [];
  if (!form.slots.length) lines.push('이 양식에서 채울 곳을 찾지 못했습니다. 그대로 내려받을 수는 있습니다.');
  if (form.report) lines.push(...form.report);
  box.hidden = !lines.length;
  box.replaceChildren(...lines.map((l) => Object.assign(document.createElement('p'), { textContent: l })));
}

function fitRows(el) {
  el.rows = Math.min(8, Math.max(1, el.value.split('\n').length));
}

function renderList() {
  $('form-list').replaceChildren(...forms.map((f) => {
    const li = document.createElement('li');
    li.dataset.form = String(f.id);
    const pick = Object.assign(document.createElement('button'), { type: 'button', className: 'pick', textContent: f.name, title: f.name });
    if (f === current) pick.setAttribute('aria-current', 'true');
    pick.onclick = () => select(f);
    const count = Object.assign(document.createElement('span'), { className: 'count', textContent: `${filledCount(f)}/${f.slots.length}` });
    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'remove', textContent: '×', title: '닫기' });
    remove.setAttribute('aria-label', `${f.name} 닫기`);
    remove.onclick = () => closeForm(f);
    li.append(pick, count, remove);
    return li;
  }));
  $('form-list-empty').hidden = forms.length > 0;
  $('download-one').disabled = busy || !current;
  $('download-all').disabled = busy || forms.length < 2;
  $('csv-run').disabled = busy || !batch || !forms.length;
  scheduleSave();
}

$('outline').addEventListener('input', (e) => {
  const ed = e.target.closest?.('[data-edit]');
  if (ed && current) {
    setEdit(current, ed.dataset.edit, readText(ed));
    paint(ed, current.stretches.get(ed.dataset.edit), current.edits.has(ed.dataset.edit));
    updateStats();
    return;
  }
  const el = e.target.closest('[data-slot]');
  if (!el || !current) return;
  const slot = current.byId.get(el.dataset.slot);
  if (el.type === 'checkbox') {
    const picks = current.picks.get(slot.id) ?? new Set();
    if (el.checked) picks.add(Number(el.dataset.option)); else picks.delete(Number(el.dataset.option));
    if (choiceValue(slot, picks)) {
      current.picks.set(slot.id, picks);
      current.source.set(slot.id, 'manual');
    } else {
      clearValue(current, slot.id);
    }
  } else {
    if (el.tagName === 'TEXTAREA') fitRows(el);
    if (el.value === slot.value || el.value === '') clearValue(current, slot.id);
    else { current.text.set(slot.id, el.value); current.source.set(slot.id, 'manual'); }
  }
  el.classList.remove('from-profile');
  updateStats();
});

// Editable text: Esc puts the original back. Where the browser has no
// plain-text editing, pasted text is put in as plain text and Enter is
// ignored (line breaks would come back as markup).
$('outline').addEventListener('keydown', (e) => {
  const ed = e.target.closest?.('[data-edit]');
  if (!ed || !current) return;
  if (e.key === 'Escape') {
    const x = current.stretches.get(ed.dataset.edit);
    ed.textContent = x.text;
    setEdit(current, ed.dataset.edit, x.text);
    paint(ed, x, false);
    updateStats();
  } else if (e.key === 'Enter' && !PLAIN_EDITING) {
    e.preventDefault();
  }
});
$('outline').addEventListener('paste', (e) => {
  if (PLAIN_EDITING || !e.target.closest?.('[data-edit]')) return;
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\r?\n/g, ' '));
});

$('edit-mode').onchange = (e) => {
  editing = e.target.checked;
  $('edit-hint').hidden = !editing;
  if (current) select(current);
};

// What a form already holds can be replaced but not emptied (an empty value
// means "leave as it is"), so an emptied input shows the original again.
$('outline').addEventListener('change', (e) => {
  const el = e.target.closest('[data-slot]');
  if (!el || !current || el.type === 'checkbox') return;
  const slot = current.byId.get(el.dataset.slot);
  if (el.value === '' && slot.value) {
    el.value = slot.value;
    toast('원래 적혀 있던 내용은 바꿀 수는 있지만 지울 수는 없습니다.');
  }
});

// ---- downloads -------------------------------------------------------------------

function splitName(name, format) {
  const m = /^(.*?)(\.[^.]*)?$/.exec(name);
  return { stem: m[1] || '양식', ext: m[2] || (format === 'hwpx' ? '.hwpx' : '.hwp') };
}

function safeName(text) {
  return String(text ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function uniqueName(name, taken) {
  if (!taken.has(name)) { taken.add(name); return name; }
  const { stem, ext } = splitName(name);
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  }
}

/** Problems of one fill, as lines to show. */
function problemLines(form, report) {
  const name = (key) => {
    const slot = form.slots.find((s) => s.key === key);
    return slot ? slot.display.filter(Boolean).join(' ') || key : key;
  };
  const short = (t) => (t.length > 24 ? `${t.slice(0, 24)}…` : t);
  return [
    ...report.failed.map((f) => `채우지 못한 곳: ${name(f.slot)} — ${f.error}`),
    ...(report.edits?.failed ?? []).map((f) => `고치지 못한 글자: “${short(f.edit.from) || '(빈 칸)'}” — ${f.error}`),
  ];
}

function save(name, bytes, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function work(fn) {
  if (busy) return;
  busy = true;
  renderList();
  try {
    await fn();
  } catch (e) {
    toast(`만들지 못했습니다: ${e.message}`, { error: true, long: true });
  } finally {
    busy = false;
    renderList();
  }
}

async function fillOne(form) {
  const { bytes, report } = await fillForm(form.bytes, recordOf(form), { edits: editsOf(form) });
  form.report = problemLines(form, report);
  if (form === current) showReport(form);
  return bytes;
}

$('download-one').onclick = () => work(async () => {
  const form = current;
  const bytes = await fillOne(form);
  const { stem, ext } = splitName(form.name, form.format);
  save(`${stem}_채움${ext}`, bytes);
  toast(form.report.length ? '내려받았습니다. 채우지 못한 곳이 있으니 위의 안내를 확인하세요.' : '내려받았습니다. 중요한 문서라면 다른 프로그램으로도 꼭 확인하세요.');
});

$('download-all').onclick = () => work(async () => {
  const taken = new Set();
  const files = [];
  let problems = 0;
  for (const form of forms) {
    const bytes = await fillOne(form);
    problems += form.report.length;
    const { stem, ext } = splitName(form.name, form.format);
    files.push({ name: uniqueName(`${stem}_채움${ext}`, taken), data: bytes });
  }
  save('채운양식.zip', await createZip(files), 'application/zip');
  toast(problems ? `내려받았습니다. 채우지 못한 곳이 ${problems}곳 있습니다.` : `양식 ${files.length}개를 내려받았습니다.`);
});

// ---- many people at once -------------------------------------------------------------

async function loadBatch(file) {
  try {
    const text = decodeText(new Uint8Array(await file.arrayBuffer()));
    const records = /\.json$/i.test(file.name) || /^\s*[[{]/.test(text) ? jsonRecords(text) : csvRecords(text);
    if (!records.length) throw new Error('줄이 없습니다');
    const columns = [...new Set(records.flatMap((r) => Object.keys(r)))].filter(Boolean);
    batch = { file: file.name, records, columns };
  } catch (e) {
    batch = null;
    $('csv-info').textContent = `${file.name}: 읽지 못했습니다. (${e.message})`;
    $('csv-name-wrap').hidden = true;
    renderList();
    return;
  }
  const select = $('csv-name');
  select.replaceChildren(
    Object.assign(document.createElement('option'), { value: '', textContent: '(번호)' }),
    ...batch.columns.map((c) => Object.assign(document.createElement('option'), { value: c, textContent: c })),
  );
  select.value = batch.columns.find((c) => /^(성명|이름|name|성명\(한글\)|신청인)$/i.test(c.replace(/\s/g, ''))) ?? '';
  $('csv-name-wrap').hidden = false;
  describeBatch();
  renderList();
}

function describeBatch() {
  if (!batch) return;
  const shown = batch.columns.slice(0, 8).join(', ') + (batch.columns.length > 8 ? ' …' : '');
  let text = `${batch.file}: ${batch.records.length}줄, 항목 ${batch.columns.length}개 (${shown})`;
  if (forms.length) {
    const sample = Object.fromEntries(batch.columns.map((c) => [c, 'x']));
    const used = new Set();
    for (const f of forms) {
      const { plan } = planFill(f.slots, sample);
      for (const { column } of plan.values()) used.add(column);
    }
    const unused = batch.columns.filter((c) => !used.has(c));
    if (unused.length) text += `. 열린 양식 어디에도 맞지 않는 항목: ${unused.join(', ')}`;
  }
  $('csv-info').textContent = text;
}

$('csv-run').onclick = () => work(async () => {
  const nameColumn = $('csv-name').value;
  const taken = new Set();
  const files = [];
  const log = [];
  const total = batch.records.length * forms.length;
  let done = 0;
  for (const [i, row] of batch.records.entries()) {
    const person = safeName(nameColumn ? row[nameColumn] : '') || String(i + 1).padStart(3, '0');
    for (const form of forms) {
      // What is on screen goes into every copy; the row's own values win.
      const record = recordOf(form);
      for (const [slot, { value }] of planFill(form.slots, row).plan) record[slot.id] = value;
      const { bytes, report } = await fillForm(form.bytes, record, { edits: editsOf(form) });
      const { stem, ext } = splitName(form.name, form.format);
      const name = uniqueName(forms.length === 1 ? `${stem}_${person}${ext}` : `${person}/${stem}${ext}`, taken);
      files.push({ name, data: bytes });
      for (const line of problemLines(form, report)) log.push(`${name}: ${line}`);
      if (++done % 5 === 0) {
        toast(`만드는 중… ${done}/${total}`);
        await new Promise((r) => setTimeout(r));
      }
    }
  }
  if (log.length) files.push({ name: uniqueName('채우지-못한-곳.txt', taken), data: new TextEncoder().encode(log.join('\r\n') + '\r\n') });
  save(`${splitName(batch.file).stem}_채운양식.zip`, await createZip(files), 'application/zip');
  toast(log.length ? `파일 ${done}개를 만들었습니다. 채우지 못한 곳은 ZIP 안의 채우지-못한-곳.txt에 적었습니다.` : `파일 ${done}개를 만들었습니다.`, { long: true });
});

$('csv').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) loadBatch(file);
};

// ---- profile -------------------------------------------------------------------

function renderProfile() {
  $('profile-rows').replaceChildren(...profile.rows.map((row, i) => {
    const div = Object.assign(document.createElement('div'), { className: 'prow' });
    const name = Object.assign(document.createElement('input'), { value: row.name, placeholder: '항목 이름' });
    const value = Object.assign(document.createElement('input'), { value: row.value, placeholder: '값' });
    name.setAttribute('aria-label', '항목 이름');
    value.setAttribute('aria-label', `${row.name || '항목'} 값`);
    name.oninput = () => { row.name = name.value; saveProfile(profile); };
    value.oninput = () => { row.value = value.value; saveProfile(profile); };
    const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: '×', title: '항목 지우기' });
    remove.setAttribute('aria-label', '항목 지우기');
    remove.onclick = () => { profile.rows.splice(i, 1); saveProfile(profile); renderProfile(); };
    div.append(name, value, remove);
    return div;
  }));
  $('profile-remember').checked = profile.remember;
}

$('profile-add').onclick = () => {
  profile.rows.push({ name: '', value: '' });
  renderProfile();
  $('profile-rows').lastElementChild?.querySelector('input')?.focus();
};

$('profile-apply').onclick = () => {
  if (!forms.length) { toast('먼저 양식을 여세요.'); return; }
  const { count, unused } = applyProfile(forms);
  if (current) refreshInputs($('outline'), current);
  updateStats();
  renderList();
  let msg = `${count}곳을 채웠습니다.`;
  if (unused.length) msg += ` 맞는 곳이 없는 항목: ${unused.join(', ')}`;
  toast(msg, { long: unused.length > 0 });
};

$('profile-remember').onchange = (e) => {
  profile.remember = e.target.checked;
  if (!saveProfile(profile) && profile.remember) toast('이 브라우저에서는 저장할 수 없습니다.', { error: true });
};

// ---- page --------------------------------------------------------------------------

let toastTimer = 0;
function toast(text, { error = false, long = false } = {}) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), long ? 9000 : 3500);
}

const FORM_FILE = /\.(hwp|hwpx)$/i;
function takeFiles(files) {
  const list = [...files];
  const docs = list.filter((f) => FORM_FILE.test(f.name));
  const data = list.filter((f) => /\.(csv|tsv|txt|json)$/i.test(f.name));
  if (docs.length) openFiles(docs).then(describeBatch);
  if (data.length) loadBatch(data[0]);
  if (!docs.length && !data.length && list.length) toast('.hwp·.hwpx 양식이나 CSV 파일을 놓아 주세요.');
}

$('open').onchange = (e) => {
  takeFiles(e.target.files);
  e.target.value = '';
};

let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer?.types?.includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  takeFiles(e.dataTransfer.files);
});

window.addEventListener('beforeunload', (e) => {
  if (!autosave && forms.some((f) => filledCount(f))) e.preventDefault();
});

// ---- 브라우저에 임시저장 ---------------------------------------------------------------

let autosave = false;
let saveTimer = 0;

/** What is needed to put the open forms back as they are (the files are kept apart). */
function snapshot() {
  return {
    savedAt: Date.now(),
    current: current?.key ?? null,
    forms: forms.map((f) => ({
      key: f.key,
      name: f.name,
      text: [...f.text],
      picks: [...f.picks].map(([id, set]) => [id, [...set]]),
      source: [...f.source],
      edits: [...f.edits.values()],
    })),
  };
}

function restoreState(form, saved) {
  for (const [id, v] of saved.text ?? []) if (form.byId.has(id)) form.text.set(id, v);
  for (const [id, list] of saved.picks ?? []) if (form.byId.has(id)) form.picks.set(id, new Set(list));
  for (const [id, v] of saved.source ?? []) if (form.byId.has(id)) form.source.set(id, v);
  for (const e of saved.edits ?? []) {
    const key = editKey(e);
    if (form.stretches.get(key)?.text === e.from) form.edits.set(key, e);
  }
}

function scheduleSave() {
  if (!autosave) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!autosave) return;
  try {
    const session = snapshot();
    await saveSession(session);
    showSaved(session.savedAt);
  } catch (e) {
    autosaveFailed(e);
  }
}

function showSaved(at) {
  const info = $('autosave-info');
  const time = at ? new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : null;
  info.textContent = `${time ? `${time}에 임시저장함. ` : ''}끄면 지워집니다. 여러 사람이 쓰는 컴퓨터에서는 켜지 마세요.`;
  info.hidden = false;
}

function autosaveFailed(e) {
  if (!autosave) return;
  autosave = false;
  setAutosaveWanted(false);
  $('autosave').checked = false;
  $('autosave-info').hidden = true;
  toast(`이 브라우저에 임시저장할 수 없습니다. (${e?.message ?? e})`, { error: true, long: true });
}

$('autosave').onchange = async (e) => {
  if (e.target.checked) {
    autosave = true;
    setAutosaveWanted(true);
    try {
      for (const f of forms) await saveFile(f.key, f.bytes);
      await saveNow();
    } catch (err) {
      autosaveFailed(err);
    }
  } else {
    autosave = false;
    clearTimeout(saveTimer);
    setAutosaveWanted(false);
    $('autosave-info').hidden = true;
    try {
      await clearAll();
      toast('임시저장한 내용을 지웠습니다.');
    } catch {
      // Nothing was kept, or storage is gone already.
    }
  }
};

// Leaving the page: write what is pending now.
window.addEventListener('pagehide', () => { if (autosave) saveNow(); });
document.addEventListener('visibilitychange', () => { if (autosave && document.visibilityState === 'hidden') saveNow(); });

/** Put back the forms kept by an earlier visit. */
async function restoreSession() {
  if (!autosaveWanted()) return;
  autosave = true;
  $('autosave').checked = true;
  try {
    const { session, files } = await loadAll();
    const restored = [];
    for (const saved of session?.forms ?? []) {
      const bytes = files.get(saved.key);
      if (!bytes) continue;
      try {
        const form = makeForm(saved.name, bytes, saved.key);
        restoreState(form, saved);
        forms.push(form);
        restored.push(form);
      } catch {
        // A file this version can no longer open is left out.
      }
    }
    showSaved(session?.savedAt);
    if (restored.length) {
      select(restored.find((f) => f.key === session.current) ?? restored[0]);
      toast(`임시저장한 양식 ${restored.length}개를 불러왔습니다.`);
    }
  } catch (e) {
    autosaveFailed(e);
  }
  renderList();
}
const restored = restoreSession();

for (const id of ['help-open', 'help-open-2']) $(id).onclick = () => $('help').showModal();

// Files opened with the installed app ("연결 프로그램").
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    await restored;
    const files = await Promise.all((params.files ?? []).map((h) => h.getFile()));
    if (files.length) takeFiles(files);
  });
}

// ?demo=<same-origin path> opens that file; used for local testing.
const demo = new URLSearchParams(location.search).getAll('demo');
if (demo.length) {
  (async () => {
    await restored;
    const files = [];
    for (const path of demo) {
      const url = new URL(path, location.href);
      if (url.origin !== location.origin) continue;
      const res = await fetch(url);
      if (res.ok) files.push(new File([await res.arrayBuffer()], decodeURIComponent(url.pathname.split('/').pop())));
    }
    takeFiles(files);
  })();
}

const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if ('serviceWorker' in navigator && (!local || new URLSearchParams(location.search).has('sw'))) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

renderProfile();
renderList();
