// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Putting a record of data (column name -> text) into a form's slots.
//
// A column is matched to slots by name:
//   slot id ("t1.r2c3", "f0") ............................. 100
//   slot key ("성명.한글", "자격증#2") ...................... 90
//   the labels run together ("성명한글", "성명(한글)"),
//   or the outermost label of the first slot under it ("성명") 80
//   the innermost label of a longer path ("한글") ........... 50
// Alias groups (labels.js) give the same names at 5 less. Outer labels
// naming the user (신청인, 지원자, ...) are ignored when matching; slots under
// another party (대리인, 배우자, ...) only match their full key or id.
//
// A column fills every slot with its best score (a name asked for twice
// on one form is filled twice) unless those slots are told apart by
// different outer labels; then it is reported as ambiguous and left out
// rather than guessed.

import { normaliseLabel, aliasIndex, DEFAULT_ALIASES, SELF_PARTIES, OTHER_PARTY } from './labels.js';
import { recordEdit, blackOver } from './slots.js';
import { cleanText } from './edit.js';

const SCORE = { id: 100, key: 90, full: 80, inner: 50 };
const ALIAS_PENALTY = 5;
const SELF = new Set(SELF_PARTIES.map(normaliseLabel));

export function isOtherParty(slot) {
  return [...slot.labels.slice(0, -1), slot.group ? normaliseLabel(slot.group) : ''].some((l) => OTHER_PARTY.test(l));
}

/** Names under which a slot can be addressed: name -> { score, qualifier }. */
function slotNames(slot, firstOfOuter) {
  const names = new Map();
  const add = (name, score, qualifier = '') => {
    if (name && (names.get(name)?.score ?? -1) < score) names.set(name, { score, qualifier });
  };
  const all = slot.labels.filter(Boolean);
  const other = isOtherParty(slot);
  add(normaliseLabel(slot.id), SCORE.id);
  // A key that only repeats the labels is no more specific than they are;
  // another party's slot answers to its key only when the key names the party.
  const key = normaliseLabel(slot.key);
  if (!other || OTHER_PARTY.test(key)) add(key, key === all.join('.') ? SCORE.full : SCORE.key);
  if (!all.length) return names;
  const sfx = slot.index > 1 ? [`#${slot.index}`, `${slot.index}`, `[${slot.index}]`, `_${slot.index}`] : [''];
  // Another party's slot is only addressed with that party in the name.
  const party = other && slot.group && !all.slice(0, -1).some((l) => OTHER_PARTY.test(l)) ? [normaliseLabel(slot.group)] : [];
  const paths = [[...party, ...all]];
  const own = all.filter((l, i) => i === all.length - 1 || !SELF.has(l));
  if (!other && own.length !== all.length) paths.push(own);
  for (const L of paths) {
    for (const x of sfx) {
      add(L.join('') + x, SCORE.full);
      add(L.join('.') + x, SCORE.full);
      if (L.length > 1) add(`${L.slice(0, -1).join('')}(${L[L.length - 1]})${x}`, SCORE.full);
      if (other || L.length === 1) continue;
      if (firstOfOuter) add(L[0] + x, SCORE.full);
      add(L[L.length - 1] + x, SCORE.inner, L.slice(0, -1).join('.'));
    }
  }
  return names;
}

export class SlotMatcher {
  constructor(slots, { aliases = DEFAULT_ALIASES } = {}) {
    this.slots = slots;
    this.alias = aliasIndex(aliases);
    const seenOuter = new Set();
    this.names = slots.map((slot) => {
      const outer = slot.labels.filter((l) => !SELF.has(l))[0] ?? slot.labels[0];
      const first = slot.index === 1 && slot.labels.length > 1 && !seenOuter.has(outer);
      if (first) seenOuter.add(outer);
      return slotNames(slot, first);
    });
  }

  /**
   * @returns {{ slots: object[], score: number, ambiguous: boolean }} the
   * best-matching slots for a column
   */
  match(column) {
    const col = normaliseLabel(column);
    const variants = new Map([[col, 0]]);
    for (const a of this.alias.get(col) ?? []) if (!variants.has(a)) variants.set(a, ALIAS_PENALTY);
    let best = 0;
    let found = [];
    this.slots.forEach((slot, i) => {
      let hit = null;
      for (const [name, penalty] of variants) {
        const n = this.names[i].get(name);
        if (n && (!hit || n.score - penalty > hit.score)) hit = { score: n.score - penalty, qualifier: n.qualifier };
      }
      if (!hit) return;
      if (hit.score > best) { best = hit.score; found = [{ slot, ...hit }]; } else if (hit.score === best) found.push({ slot, ...hit });
    });
    const qualifiers = new Set(found.map((f) => f.qualifier));
    return { slots: found.map((f) => f.slot), score: best, ambiguous: qualifiers.size > 1 };
  }
}

/**
 * Put `value` into `slot`.
 * @param {object} [options]
 * @param {'keep'|'drop'} [options.lineSegs] the edited paragraph's layout cache (default 'drop', PROVENANCE.md R1)
 * @param {boolean} [options.markFieldsModified] set a filled field's "modified" flag (default true)
 */
export function setSlotValue(slot, value, { lineSegs = 'drop', markFieldsModified = true } = {}) {
  if (slot._fill) {
    slot._fill(String(value), { lineSegs });
  } else {
    const { paragraph, start, end, styleOf = null } = slot._range();
    const length = cleanText(value).length;
    paragraph.replaceRange(start, end, String(value), { lineSegs, styleOf });
    recordEdit(paragraph, start, end, length);
    if (slot._field && markFieldsModified) slot._field.dirty = true;
    // A field's value takes the field's own style (PROVENANCE.md C9); other text written over coloured text comes out black.
    if (!slot._field && slot._doc) blackOver(slot._doc, paragraph, start, start + length);
  }
  slot.value = String(value);
}

/**
 * Which slot each column of a record would fill, without changing anything.
 * @returns {{ plan: Map<object, { column: string, value: string, score: number }>, report: object }}
 */
export function planFill(slots, record, options = {}) {
  const matcher = new SlotMatcher(slots, options);
  const entries = record instanceof Map ? [...record] : Object.entries(record);
  const plan = new Map(); // slot -> { column, value, score }
  const report = { filled: [], failed: [], unmatched: [], ambiguous: [], conflicts: [] };
  for (const [column, value] of entries) {
    if (value === undefined || value === null || value === '') continue;
    const { slots: found, score, ambiguous } = matcher.match(column);
    if (!found.length) { report.unmatched.push(column); continue; }
    if (ambiguous) { report.ambiguous.push({ column, candidates: found.map((s) => s.key) }); continue; }
    for (const slot of found) {
      const prev = plan.get(slot);
      if (prev && prev.score === score) {
        report.conflicts.push({ slot: slot.key, columns: [prev.column, column] });
        continue;
      }
      if (!prev || score > prev.score) plan.set(slot, { column, value: String(value), score });
    }
  }
  return { plan, report };
}

/**
 * Fill `slots` of a document from one record.
 * @param {object[]} slots from findSlots(doc)
 * @param {Record<string, string>|Map<string, string>} record column -> text
 * @returns {{ filled: Array<{column, slot, value}>, failed: Array<{column, slot, error}>, unmatched: string[], ambiguous: Array<{column, candidates: string[]}>, conflicts: Array<{slot, columns: string[]}> }}
 */
export function fillSlots(slots, record, options = {}) {
  const { plan, report } = planFill(slots, record, options);
  for (const [slot, { column, value }] of plan) {
    try {
      setSlotValue(slot, value, options);
      report.filled.push({ column, slot: slot.key, value });
    } catch (e) {
      // Edits check their range before changing anything, so a refused
      // slot leaves the document as it was.
      if (!(e instanceof RangeError)) throw e;
      report.failed.push({ column, slot: slot.key, error: e.message });
    }
  }
  return report;
}
