// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Drawing a document outline (engine/src/form/outline.js) as HTML, with an
// input wherever a slot is. This is a reading view of the form's structure,
// not its printed layout; the file itself is only changed by the engine.
//
// In editing mode the form's own text can be changed as well: each stretch
// of plain text becomes an editable span (data-edit = "p:start:end").

import { parseDate } from './engine/form/inline.js';

/** Whether this browser has plain-text-only editable elements. */
export const PLAIN_EDITING = (() => {
  const el = document.createElement('span');
  try { el.contentEditable = 'plaintext-only'; } catch { return false; }
  return el.contentEditable === 'plaintext-only';
})();

let editing = false;

/**
 * @param {HTMLElement} root
 * @param {object[]} blocks from documentOutline()
 * @param {object} form { byId: Map(slot id -> slot), text: Map, picks: Map, source: Map, edits: Map }
 * @param {{ editing?: boolean }} [options]
 */
export function renderOutline(root, blocks, form, options = {}) {
  editing = !!options.editing;
  root.classList.toggle('editing', editing);
  root.replaceChildren(...blocks.map((b) => block(b, form)));
}

export const editKey = (s) => `${s.p}:${s.start}:${s.end}`;

/** The text of an editable span as typed (line breaks included). */
export function readText(el) {
  let out = '';
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) out += c.data;
      else if (c.nodeName === 'BR') out += '\n';
      else {
        if ((c.nodeName === 'DIV' || c.nodeName === 'P') && out) out += '\n';
        walk(c);
      }
    }
  };
  walk(el);
  // A lone line break is what browsers leave in an emptied editable element.
  return out === '\n' ? '' : out;
}

function block(b, form) {
  return b.type === 'table' ? table(b, form) : paragraph(b, form);
}

function paragraph(b, form) {
  const p = document.createElement('p');
  if (b.align && b.align !== 'left') p.className = `al-${b.align}`;
  for (const s of b.segments) {
    if (s.slot === undefined) {
      p.append(text(s, form));
    } else {
      const slot = form.byId.get(s.slot);
      if (slot) p.append(slot.kind === 'choice' ? choiceBox(slot, s.option, form) : textInput(slot, s.size, form));
    }
  }
  return p;
}

function text(s, form) {
  const edit = s.p !== undefined ? form.edits.get(editKey(s)) : null;
  if (s.p === undefined || (!editing && !edit)) {
    if (!s.bold && !s.color) return document.createTextNode(s.text);
    const el = Object.assign(document.createElement(s.bold ? 'b' : 'span'), { textContent: s.text });
    paint(el, s, false);
    return el;
  }
  const el = document.createElement('span');
  el.className = 'edit';
  el.classList.toggle('bold', s.bold);
  el.dataset.edit = editKey(s);
  el.textContent = edit ? edit.to : s.text;
  paint(el, s, !!edit);
  if (editing) {
    el.contentEditable = PLAIN_EDITING ? 'plaintext-only' : 'true';
    el.spellcheck = false;
    if (edit) el.title = `원래: ${s.text || '(빈 칸)'}`;
  }
  return el;
}

/**
 * Coloured text is shown in its colour (placeholders are often red); once
 * edited it is black, as it will be in the file.
 */
export function paint(el, s, edited) {
  const tint = !edited && !!s.color;
  el.style.color = tint ? s.color : '';
  el.classList.toggle('tint', tint);
  if (el.dataset.edit) el.classList.toggle('edited', edited);
}

function table(b, form) {
  const t = document.createElement('table');
  const body = document.createElement('tbody');
  const rows = new Map();
  for (const c of [...b.cells].sort((x, y) => x.row - y.row || x.col - y.col)) {
    if (!rows.has(c.row)) rows.set(c.row, []);
    rows.get(c.row).push(c);
  }
  // Rows are drawn in order; a row with no cells of its own (all covered
  // by cells above) still needs a <tr> so that row spans line up.
  for (let r = 0; r < b.rows; r++) {
    const tr = document.createElement('tr');
    for (const c of rows.get(r) ?? []) {
      const td = document.createElement('td');
      if (c.rowSpan > 1) td.rowSpan = c.rowSpan;
      if (c.colSpan > 1) td.colSpan = c.colSpan;
      if (c.border) cellBorder(td, c.border);
      const slot = c.slot !== undefined ? form.byId.get(c.slot) : null;
      if (slot) {
        td.classList.add('slot-cell');
        td.append(cellInput(slot, form));
      } else {
        td.append(...c.blocks.map((x) => block(x, form)));
        // An empty cell (a gap row, a thin rule row) keeps its own height.
        if (c.blocks.every(blank)) {
          td.classList.add('spacer');
          td.style.height = `${(c.height / 7200) * 96}px`;
        }
      }
      tr.append(td);
    }
    body.append(tr);
  }
  t.append(body);
  return t;
}

const blank = (b) => b.type === 'p' && b.segments.every((s) => s.slot === undefined && !s.text.trim());

/** CSS border styles for the line types of owpml-ksx6101 §7.3 (others print solid). */
const LINE_STYLE = {
  DOT: 'dotted', CIRCLE: 'dotted', DASH: 'dashed', DASH_DOT: 'dashed', DASH_DOT_DOT: 'dashed', LONG_DASH: 'dashed',
  DOUBLE_SLIM: 'double', SLIM_THICK: 'double', THICK_SLIM: 'double', SLIM_THICK_SLIM: 'double', DOUBLEWAVE: 'double',
};

/** Black lines take the page's rule colour, so that they show in dark mode too. */
const ink = (color) => (!color || color === '#000000' ? 'var(--rule)' : color);

function line(l) {
  if (!l) return 'none';
  const style = LINE_STYLE[l.type] ?? 'solid';
  const px = Math.max(style === 'double' ? 3 : 1, Math.round((l.width * 96) / 25.4));
  return `${px}px ${style} ${ink(l.color)}`;
}

/** A cell drawn with the form's own borders, diagonals and background. */
function cellBorder(td, b) {
  td.style.borderLeft = line(b.left);
  td.style.borderRight = line(b.right);
  td.style.borderTop = line(b.top);
  td.style.borderBottom = line(b.bottom);
  // White is the paper itself.
  if (b.fill && !/^#(f[a-f]){3}$/.test(b.fill)) {
    td.classList.add('filled');
    td.style.setProperty('--fill', b.fill);
  }
  // A gradient whose middle runs corner to corner: "/" for slash, "\" for back-slash.
  const c = ink(b.diagonal?.color);
  const stroke = (dir) => `linear-gradient(${dir}, transparent calc(50% - .6px), ${c} calc(50% - .6px), ${c} calc(50% + .6px), transparent calc(50% + .6px))`;
  const diagonals = [b.slash && stroke('to top left'), b.backSlash && stroke('to top right')].filter(Boolean);
  if (diagonals.length) {
    td.classList.add('crossed');
    td.style.backgroundImage = diagonals.join(', ');
  }
}

function describe(slot) {
  const name = slot.display.filter(Boolean).join(' › ') || slot.key;
  return slot.key && slot.key !== name ? `${name}  [${slot.key}]` : name;
}

function decorate(el, slot, form) {
  el.classList.add('slot');
  el.dataset.slot = slot.id;
  el.title = describe(slot);
  el.setAttribute('aria-label', slot.display.filter(Boolean).join(' ') || slot.key);
  if (form.source.get(slot.id) === 'profile') el.classList.add('from-profile');
  return el;
}

function cellInput(slot, form) {
  const el = document.createElement('textarea');
  el.rows = 1;
  el.value = form.text.get(slot.id) ?? slot.value;
  if (slot.hint) el.placeholder = slot.hint;
  return decorate(el, slot, form);
}

function textInput(slot, size, form) {
  const el = document.createElement('input');
  const blank = slot.kind === 'blank' ? slot.blank : null;
  el.type = 'text';
  if (slot.hint && blank !== 'date') el.placeholder = slot.hint;
  // About as wide as the space the slot takes in the form, within reason.
  const want = slot.kind === 'field' ? (slot.hint ?? '').length + 2 : Math.round((size ?? 8) * 1.2);
  el.size = Math.max(blank === 'append' ? 12 : 6, Math.min(40, want));
  if (blank === 'date') el.dataset.date = '1';
  setValue(el, form.text.get(slot.id) ?? slot.value);
  return decorate(el, slot, form);
}

/** A date blank shows a date picker while its value is a whole date (or empty). */
function setValue(el, value) {
  if (el.dataset.date) {
    const iso = isoDate(value);
    el.type = iso !== null || value === '' ? 'date' : 'text';
    if (el.type === 'date') { if (el.value !== (iso ?? '')) el.value = iso ?? ''; return; }
  }
  if (el.value !== value) el.value = value;
}

function isoDate(value) {
  try {
    const { year, month, day } = parseDate(value);
    return day ? `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}` : null;
  } catch {
    return null;
  }
}

function choiceBox(slot, option, form) {
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.dataset.option = String(option);
  const already = slot._options[option]?.checked;
  el.checked = already || !!form.picks.get(slot.id)?.has(option);
  // A box already ticked in the file stays ticked: the filler only adds marks.
  if (already) { el.disabled = true; el.dataset.already = '1'; }
  decorate(el, slot, form);
  const label = slot.options[option];
  if (label) el.title = `${describe(slot)}: ${label}`;
  if (slot._unaddressable?.has(option)) {
    el.disabled = true;
    el.title += ' (이 상자는 채울 수 없습니다)';
  }
  // A form object's caption is part of the object, not of the text around it.
  if (slot._options[option]?.kind === 'form' && label) {
    const wrap = Object.assign(document.createElement('label'), { className: 'form-choice' });
    wrap.append(el, label);
    return wrap;
  }
  return el;
}

/** Put the current values of a form back into its drawn inputs. */
export function refreshInputs(root, form) {
  for (const el of root.querySelectorAll('[data-slot]')) {
    const slot = form.byId.get(el.dataset.slot);
    if (!slot) continue;
    if (el.type === 'checkbox') {
      if (!el.dataset.already) el.checked = !!form.picks.get(slot.id)?.has(Number(el.dataset.option));
    } else {
      setValue(el, form.text.get(slot.id) ?? slot.value);
    }
    el.classList.toggle('from-profile', form.source.get(slot.id) === 'profile');
  }
}
