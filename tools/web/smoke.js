#!/usr/bin/env node
// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// End-to-end check of the built webapp in headless Chromium, driven over
// the DevTools protocol: open two corpus forms, fill from the profile and
// by hand, download, and read the downloaded files back with the engine;
// then fill both forms for two people from a CSV and check the ZIP.
//
//   node tools/web/smoke.js [--chromium /usr/bin/chromium] [--shots dir]
//
// Needs the corpus (provenance/Corpus); skips without it.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.js';
import { openDocument, findSlots, documentOutline } from '../../engine/src/index.js';
import { ZipArchive } from '../../engine/src/container/zip.js';
import { FILLED } from '../../engine/src/form/choice.js';

const CORPUS = fileURLToPath(new URL('../../provenance/Corpus/', import.meta.url));
const FORMS = ['hwp5/0085.hwp', 'hwpx/0042.hwpx'];
const RED = 'hwp5/0037.hwp'; // red placeholders
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const CHROMIUM = opt('--chromium', '/usr/bin/chromium');
const SHOTS = opt('--shots', null);

if (![...FORMS, RED].every((f) => existsSync(CORPUS + f))) {
  console.log('smoke: corpus not found, skipped');
  process.exit(0);
}

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

// ---- a minimal DevTools protocol client -------------------------------------------

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.next = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, fail } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) fail(new Error(`${msg.error.message} (${msg.error.data ?? ''})`)); else ok(msg.result);
      } else {
        for (const l of this.listeners) l(msg);
      }
    };
    this.ready = new Promise((ok, fail) => { this.ws.onopen = ok; this.ws.onerror = fail; });
  }

  send(method, params = {}, sessionId) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((ok, fail) => this.pending.set(id, { ok, fail }));
  }

  /** The first event `method` for which `test(params)` holds. */
  waitEvent(method, test = () => true, timeout = 20000) {
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => { this.listeners.delete(l); fail(new Error(`timed out waiting for ${method}`)); }, timeout);
      const l = (msg) => {
        if (msg.method === method && test(msg.params)) { clearTimeout(timer); this.listeners.delete(l); ok(msg.params); }
      };
      this.listeners.add(l);
    });
  }
}

function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'hankan-smoke-'));
  const proc = spawn(CHROMIUM, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--window-size=1400,1800', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const url = new Promise((ok, fail) => {
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) ok(m[1]);
    });
    proc.on('exit', (code) => fail(new Error(`chromium exited (${code}): ${err.slice(-500)}`)));
  });
  return { proc, profile, url };
}

// ---- the run --------------------------------------------------------------------------

const server = await serve({ port: 0, mounts: { '/corpus/': CORPUS } });
const base = `http://127.0.0.1:${server.address().port}/`;
const downloads = mkdtempSync(join(tmpdir(), 'hankan-dl-'));
const browser = launch();
let cdp;

try {
  cdp = new Cdp(await browser.url);
  await cdp.ready;
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads, eventsEnabled: true });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => cdp.send(m, p, sessionId);

  const errors = [];
  const watched = new Set([sessionId]);
  cdp.listeners.add((msg) => {
    if (!watched.has(msg.sessionId)) return;
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(msg.params.entry.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('DOM.enable');

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const waitFor = async (expression, what, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out: ${what}`);
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64'));
  };
  /** Click `selector` and return the bytes of the download it starts. */
  const download = async (selector) => {
    const begin = cdp.waitEvent('Browser.downloadWillBegin');
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const { guid, suggestedFilename } = await begin;
    await cdp.waitEvent('Browser.downloadProgress', (p) => p.guid === guid && p.state === 'completed', 60000);
    return { name: suggestedFilename, bytes: new Uint8Array(readFileSync(join(downloads, guid))) };
  };
  const slotsOf = (bytes) => findSlots(openDocument(bytes));

  // 1. Open both forms.
  await send('Page.navigate', { url: `${base}?${FORMS.map((f) => `demo=/corpus/${f}`).join('&')}` });
  await waitFor(`document.querySelectorAll('#form-list li').length === ${FORMS.length}`, 'forms listed');
  const engineSlots = FORMS.map((f) => findSlots(openDocument(new Uint8Array(readFileSync(CORPUS + f)))));
  for (const [i, f] of FORMS.entries()) {
    await evaluate(`document.querySelectorAll('#form-list button.pick')[${i}].click()`);
    const expected = engineSlots[i].reduce((n, s) => n + (s.kind === 'choice' ? s.options.length : 1), 0);
    const shown = await evaluate(`document.querySelectorAll('#outline [data-slot]').length`);
    check(shown === expected, `${f}: ${shown} inputs for ${expected} slot places`);
  }
  check(await evaluate(`document.querySelector('footer').textContent.includes('본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.')`), 'attribution in the footer');
  check(await evaluate(`document.getElementById('help').textContent.includes('채운 양식의 모양이 틀어질 가능성은 여전히 있습니다')`), 'disclaimer in the help');

  // 2. The profile fills 성명 in both forms.
  await evaluate(`(() => {
    const rows = document.querySelectorAll('#profile-rows .prow');
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(rows[0].children[0], '성명'); set(rows[0].children[1], '홍길동');
    document.getElementById('profile-apply').click();
  })()`);
  await evaluate(`document.querySelectorAll('#form-list button.pick')[0].click()`);
  const fromProfile = await evaluate(`[...document.querySelectorAll('#outline .from-profile')].map((e) => e.dataset.slot)`);
  check(fromProfile.length > 0, `profile filled ${fromProfile.length} place(s) in ${FORMS[0]}`);

  // 3. By hand: the first empty cell and the first box of the first check-box slot.
  const manual = await evaluate(`(() => {
    const el = [...document.querySelectorAll('#outline textarea[data-slot]')].find((e) => !e.value && !e.classList.contains('from-profile'));
    el.value = '수동 입력'; el.dispatchEvent(new Event('input', { bubbles: true }));
    const box = document.querySelector('#outline input[type=checkbox][data-slot]:not(:disabled)');
    if (box) { box.checked = true; box.dispatchEvent(new Event('input', { bubbles: true })); }
    return { cell: el.dataset.slot, box: box ? [box.dataset.slot, Number(box.dataset.option)] : null };
  })()`);

  // 3b. Editing mode: change printed text, and write into an empty paragraph, in both forms.
  await evaluate(`(() => { const t = document.getElementById('edit-mode'); t.checked = true; t.dispatchEvent(new Event('change')); })()`);
  const editIn = (i) => evaluate(`(() => {
    document.querySelectorAll('#form-list button.pick')[${i}].click();
    const type = (el, text) => { el.textContent = text; el.dispatchEvent(new Event('input', { bubbles: true })); };
    const spans = [...document.querySelectorAll('#outline [data-edit][contenteditable]')];
    const word = spans.find((e) => e.textContent.trim().length >= 4);
    const from = word.textContent;
    type(word, from + '(고침)');
    const empty = spans.find((e) => e.textContent === '');
    if (empty) type(empty, '빈 칸 입력');
    return { from, to: from + '(고침)', empty: !!empty, edited: document.querySelectorAll('#outline .edit.edited').length };
  })()`);
  const edits = [await editIn(1), await editIn(0)].reverse(); // edits[i] belongs to FORMS[i]
  for (const [i, e] of edits.entries()) check(e.edited === (e.empty ? 2 : 1), `${FORMS[i]}: editing mode marks ${e.edited} edited stretch(es)`);
  await shot('form.png');

  // A filled blank is no longer a blank, so the output is checked by its
  // text, and a ticked box by finding its slot again by name.
  const one = await download('#download-one');
  check(one.name === '0085_채움.hwp', `download name ${one.name}`);
  const textOf = (bytes) => [...openDocument(bytes).walk()].map((w) => w.paragraph.text).join('\n');
  const count = (text, word) => text.split(word).length - 1;
  const original = textOf(new Uint8Array(readFileSync(CORPUS + FORMS[0])));
  const filled = textOf(one.bytes);
  check(count(filled, '홍길동') === count(original, '홍길동') + fromProfile.length, `profile value is in the file ${fromProfile.length} time(s)`);
  check(filled.includes('수동 입력'), `typed value for ${manual.cell} is in the file`);
  const checkedForms = (bytes) => [...openDocument(bytes).walk()]
    .flatMap((w) => w.paragraph.units().filter((u) => u.control?.formType && u.control.checked)).length;
  // A box ticked on a line of its own is no longer a choice once ticked, so
  // ticked boxes are counted: filled glyphs, or checked form objects.
  const ticked = (bytes) => {
    if (!manual.box) return true;
    const [id, option] = manual.box;
    const slot = engineSlots[0].find((x) => x.id === id);
    const o = slot._options[option];
    if (o.kind === 'char') return count(textOf(bytes), FILLED[o.box]) === count(original, FILLED[o.box]) + 1;
    if (o.kind === 'form') return checkedForms(bytes) === checkedForms(new Uint8Array(readFileSync(CORPUS + FORMS[0]))) + 1;
    return slotsOf(bytes).find((x) => x.kind === 'choice' && x.key === slot.key)?._options[option]?.checked === true;
  };
  if (manual.box) check(ticked(one.bytes), `ticked box ${manual.box.join('/')} is ticked in the file`);
  const hasEdits = (text, e) => text.includes(e.to) && (!e.empty || text.includes('빈 칸 입력'));
  check(hasEdits(filled, edits[0]), `edited text "${edits[0].to}"${edits[0].empty ? ' and the empty paragraph' : ''} in the file`);

  // 4. Many people: both forms for each CSV row.
  const csv = join(downloads, 'people.csv');
  writeFileSync(csv, '이름,휴대폰\n김철수,010-1111-2222\n이영희,010-3333-4444\n');
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#csv' });
  await send('DOM.setFileInputFiles', { nodeId, files: [csv] });
  await waitFor(`!document.getElementById('csv-run').disabled`, 'CSV loaded');
  check((await evaluate(`document.getElementById('csv-name').value`)) === '이름', 'name column guessed');
  const zip = await download('#csv-run');
  const archive = new ZipArchive(zip.bytes);
  const names = archive.list().map((e) => e.name).sort();
  check(JSON.stringify(names) === JSON.stringify(['김철수/0042.hwpx', '김철수/0085.hwp', '이영희/0042.hwpx', '이영희/0085.hwp']), `ZIP holds ${names.join(', ')}`);
  for (const person of ['김철수', '이영희']) {
    const bytes = archive.read(`${person}/0085.hwp`);
    const text = textOf(bytes);
    check(count(text, person) === fromProfile.length && !text.includes('홍길동'), `${person}/0085.hwp: the row's name replaces the profile's`);
    check(text.includes('수동 입력') && ticked(bytes), `${person}/0085.hwp: values typed on screen kept`);
    check(hasEdits(text, edits[0]) && hasEdits(textOf(archive.read(`${person}/0042.hwpx`)), edits[1]), `${person}: text edits in both files`);
  }

  await evaluate(`document.getElementById('help').showModal()`);
  await shot('help.png');

  /** Another page (tab) of the same browser, watched for errors. */
  const openPage = async (url) => {
    const { targetId: id } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId: id, flatten: true });
    watched.add(sid);
    const s2 = (m, p) => cdp.send(m, p, sid);
    for (const m of ['Runtime.enable', 'Log.enable', 'Page.enable']) await s2(m);
    const ev = async (expression) => {
      const r = await s2('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };
    const wait = async (expression, what, timeout = 20000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (await ev(expression)) return; await new Promise((r) => setTimeout(r, 100)); }
      throw new Error(`timed out: ${what}`);
    };
    const loaded = cdp.waitEvent('Page.loadEventFired', () => true, 20000);
    await s2('Page.navigate', { url });
    await loaded;
    return { ev, wait, close: () => cdp.send('Target.closeTarget', { targetId: id }) };
  };

  // 6. Coloured text: shown in its colour, black once edited, black in the file.
  const red = await openPage(`${base}?demo=/corpus/${RED}`);
  await red.wait(`document.querySelectorAll('#form-list li').length === 1`, 'red form listed');
  check(await red.ev(`[...document.querySelectorAll('#outline span, #outline b')].some((e) => e.style.color && e.textContent.includes('간이'))`), 'red placeholder shown in colour');
  const recoloured = await red.ev(`(() => {
    const t = document.getElementById('edit-mode'); t.checked = true; t.dispatchEvent(new Event('change'));
    const el = [...document.querySelectorAll('#outline [data-edit]')].find((e) => e.style.color && e.textContent === '(간이)');
    const before = el.style.color;
    el.textContent = '(일반)'; el.dispatchEvent(new Event('input', { bubbles: true }));
    return { before, after: el.style.color };
  })()`);
  check(recoloured.before && !recoloured.after, `edited red text shown black (${recoloured.before} -> "${recoloured.after}")`);
  {
    const begin = cdp.waitEvent('Browser.downloadWillBegin');
    await red.ev(`document.getElementById('download-one').click()`);
    const { guid } = await begin;
    await cdp.waitEvent('Browser.downloadProgress', (p) => p.guid === guid && p.state === 'completed', 60000);
    const doc = openDocument(new Uint8Array(readFileSync(join(downloads, guid))));
    const segs = [];
    const visit = (blocks) => { for (const b of blocks) { if (b.type === 'p') segs.push(...b.segments); if (b.type === 'table') for (const c of b.cells) visit(c.blocks); } };
    visit(documentOutline(doc, findSlots(doc)));
    const seg = segs.find((x) => x.text?.includes('(일반)'));
    check(seg && !seg.color, 'edited red text is black in the file');
  }

  // 7. 브라우저에 임시저장: kept across a reload, gone once turned off.
  await red.ev(`(() => { const a = document.getElementById('autosave'); a.checked = true; a.dispatchEvent(new Event('change')); })()`);
  await red.wait(`document.getElementById('autosave-info').textContent.includes('임시저장함')`, 'saved');
  await red.close();
  const again = await openPage(base);
  await again.wait(`document.querySelectorAll('#form-list li').length === 1`, 'saved form back', 10000);
  check(await again.ev(`[...document.querySelectorAll('#outline .edit.edited')].some((e) => e.textContent === '(일반)')`), 'saved form comes back with its edit');
  check(await again.ev(`document.getElementById('autosave').checked`), 'temporary save still on');
  await again.ev(`(() => { const a = document.getElementById('autosave'); a.checked = false; a.dispatchEvent(new Event('change')); })()`);
  await new Promise((r) => setTimeout(r, 500));
  await again.close();
  const fresh = await openPage(base);
  await new Promise((r) => setTimeout(r, 1500));
  check(await fresh.ev(`document.querySelectorAll('#form-list li').length === 0 && !document.getElementById('autosave').checked`), 'turned off: nothing comes back');
  await fresh.close();

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);

  // 5. Offline: with the service worker installed, the app loads without the network.
  {
    const { targetId: t2 } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: s2 } = await cdp.send('Target.attachToTarget', { targetId: t2, flatten: true });
    const send2 = (m, p) => cdp.send(m, p, s2);
    const eval2 = async (expression) => (await send2('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
    await send2('Page.enable');
    await send2('Network.enable');
    await send2('Page.navigate', { url: `${base}?sw=1` });
    const cached = await eval2(`navigator.serviceWorker.ready
      .then(() => caches.keys())
      .then((keys) => caches.open(keys.find((k) => k.startsWith('hankan-'))))
      .then((c) => c.keys()).then((r) => r.length)`);
    const expected = JSON.parse(/const PRECACHE = (\[[^\]]*\]);/.exec(readFileSync(fileURLToPath(new URL('../../webpage-worker/public/sw.js', import.meta.url)), 'utf8'))[1]).length;
    check(cached === expected, `service worker cached ${cached} of ${expected} files`);
    await send2('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const loaded = cdp.waitEvent('Page.loadEventFired', () => true, 10000);
    await send2('Page.reload', { ignoreCache: false });
    await loaded;
    check(await eval2(`!!document.getElementById('open') && typeof document.getElementById('help').showModal === 'function' && !!document.querySelector('#profile-rows .prow')`), 'app loads and runs offline');
    await cdp.send('Target.closeTarget', { targetId: t2 });
  }
} catch (e) {
  check(false, e.stack ?? String(e));
} finally {
  cdp?.ws.close();
  browser.proc.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(browser.profile, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
}

console.log(failures ? `smoke: ${failures} failure(s)` : 'smoke: all passed');
process.exit(failures ? 1 : 0);
