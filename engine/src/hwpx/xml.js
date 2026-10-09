// 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// A small XML 1.0 parser that keeps source offsets, and a splice-based
// editor. Generic; no knowledge of any XML vocabulary.
//
// Every element records where its start tag, content and end tag lie in
// the source text, so an edit replaces exactly the characters it changes
// and every other character of the document is written back as it was.
// No DTD processing; only the predefined and numeric entities are decoded.

import { FormatError } from '../util/bytes.js';

export class XmlElement {
  constructor(name, start, parent) {
    this.type = 'element';
    this.name = name;
    const i = name.indexOf(':');
    this.prefix = i < 0 ? '' : name.slice(0, i);
    this.local = i < 0 ? name : name.slice(i + 1);
    /** @type {Map<string, {value: string, start: number, end: number}>} value span excludes quotes */
    this.attrs = new Map();
    /** @type {Array<XmlElement|XmlText>} */
    this.children = [];
    this.parent = parent;
    this.start = start;     // '<' of the start tag
    this.openEnd = -1;      // just after '>' of the start tag
    this.closeStart = -1;   // '<' of the end tag (= openEnd for a self-closing tag)
    this.end = -1;          // just after the element
    this.selfClosing = false;
  }

  attr(name) { return this.attrs.get(name)?.value; }

  /** Child elements with the given local name. */
  all(local) { return this.children.filter((c) => c.type === 'element' && c.local === local); }
  first(local) { return this.children.find((c) => c.type === 'element' && c.local === local) ?? null; }

  /** Descendants (depth first, document order) matching a local name. */
  *descendants(local) {
    for (const c of this.children) {
      if (c.type !== 'element') continue;
      if (!local || c.local === local) yield c;
      yield* c.descendants(local);
    }
  }
}

export class XmlText {
  constructor(start, end, raw, cdata) {
    this.type = 'text';
    this.start = start;
    this.end = end;
    this.raw = raw;
    this.cdata = cdata;
  }

  get value() { return this.cdata ? this.raw : decodeEntities(this.raw); }
}

const NAME_END = /[\s/>=]/;

/** Parse `src` into a tree; throws FormatError on malformed input. */
export function parseXml(src) {
  const root = new XmlElement('#document', 0, null);
  root.openEnd = 0;
  let cur = root;
  let i = 0;
  const n = src.length;
  const fail = (msg) => { throw new FormatError(`xml: ${msg} at offset ${i}`); };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0 || lt > i) {
      const end = lt < 0 ? n : lt;
      cur.children.push(new XmlText(i, end, src.slice(i, end), false));
      i = end;
      continue;
    }
    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i + 4);
      if (e < 0) fail('unterminated comment');
      i = e + 3;
    } else if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i + 9);
      if (e < 0) fail('unterminated CDATA');
      cur.children.push(new XmlText(i, e + 3, src.slice(i + 9, e), true));
      i = e + 3;
    } else if (src.startsWith('<?', i)) {
      const e = src.indexOf('?>', i + 2);
      if (e < 0) fail('unterminated processing instruction');
      i = e + 2;
    } else if (src.startsWith('<!', i)) {
      // DOCTYPE (with an optional internal subset): skipped.
      let depth = 0, j = i + 2;
      for (; j < n; j++) {
        if (src[j] === '[') depth++;
        else if (src[j] === ']') depth--;
        else if (src[j] === '>' && depth <= 0) break;
      }
      if (j >= n) fail('unterminated declaration');
      i = j + 1;
    } else if (src[i + 1] === '/') {
      const e = src.indexOf('>', i);
      if (e < 0) fail('unterminated end tag');
      const name = src.slice(i + 2, e).trim();
      if (name !== cur.name) fail(`end tag </${name}> does not match <${cur.name}>`);
      cur.closeStart = i;
      cur.end = e + 1;
      cur = cur.parent;
      i = e + 1;
    } else {
      let j = i + 1;
      while (j < n && !NAME_END.test(src[j])) j++;
      const el = new XmlElement(src.slice(i + 1, j), i, cur);
      if (!el.name) fail('empty element name');
      // attributes
      for (;;) {
        while (j < n && /\s/.test(src[j])) j++;
        if (j >= n) fail('unterminated start tag');
        if (src[j] === '>') { el.openEnd = j + 1; break; }
        if (src[j] === '/' && src[j + 1] === '>') { el.openEnd = j + 2; el.selfClosing = true; break; }
        let k = j;
        while (k < n && !NAME_END.test(src[k])) k++;
        const aname = src.slice(j, k);
        while (k < n && /\s/.test(src[k])) k++;
        if (src[k] !== '=') fail(`attribute ${aname} without value`);
        k++;
        while (k < n && /\s/.test(src[k])) k++;
        const q = src[k];
        if (q !== '"' && q !== "'") fail(`unquoted value for ${aname}`);
        const ve = src.indexOf(q, k + 1);
        if (ve < 0) fail('unterminated attribute value');
        el.attrs.set(aname, { value: decodeEntities(src.slice(k + 1, ve)), start: k + 1, end: ve });
        j = ve + 1;
      }
      cur.children.push(el);
      i = el.openEnd;
      if (el.selfClosing) {
        el.closeStart = el.openEnd;
        el.end = el.openEnd;
      } else {
        cur = el;
      }
    }
  }
  if (cur !== root) throw new FormatError(`xml: <${cur.name}> is not closed`);
  root.end = n;
  root.closeStart = n;
  return root;
}

const ENTITY = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(cp);
    }
    if (!(e in ENTITY)) throw new FormatError(`xml: unknown entity &${e};`);
    return ENTITY[e];
  });
}

export function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;');
}

/**
 * A parsed XML source that can be edited in place. Every edit splices the
 * source text and moves the recorded offsets of the nodes after it, so the
 * tree always describes the current text. Nodes outside an edit keep their
 * identity and their characters.
 */
export class XmlDocument {
  constructor(src) {
    this.src = src;
    this.root = parseXml(src);
    this.edits = 0;
  }

  /** The document element. */
  get element() {
    return this.root.children.find((c) => c.type === 'element') ?? null;
  }

  /** Source text of a node. */
  text(node) {
    return this.src.slice(node.start, node.end);
  }

  /** Start tag of an element, written as a non-empty start tag. */
  openTag(el) {
    const tag = this.src.slice(el.start, el.openEnd);
    return el.selfClosing ? tag.slice(0, -2).replace(/\s+$/, '') + '>' : tag;
  }

  /** Replace a node with the nodes parsed from `xml`; returns them. */
  replaceNode(node, xml) {
    const parent = node.parent;
    const index = parent.children.indexOf(node);
    if (index < 0) throw new Error('xml: node is not in the tree');
    const nodes = this.#fragment(xml, node.start, parent);
    this.#splice(node.start, node.end, xml);
    parent.children.splice(index, 1, ...nodes);
    return nodes;
  }

  /** Insert the nodes parsed from `xml` as children of `parent` before child `index`. */
  insertChildren(parent, index, xml) {
    if (parent.selfClosing) throw new Error('xml: cannot insert into a self-closing element; replace it instead');
    const at = index < parent.children.length ? parent.children[index].start : parent.closeStart;
    const nodes = this.#fragment(xml, at, parent);
    this.#splice(at, at, xml);
    parent.children.splice(index, 0, ...nodes);
    return nodes;
  }

  /**
   * Split `el` before its child `index`: that child and the ones after it
   * move, as the same nodes, into a new element with the start tag
   * `openTag`, placed right after `el`. Returns the new element.
   */
  splitElement(el, index, openTag) {
    if (index <= 0 || index >= el.children.length) throw new Error('xml: split point must be inside the element');
    const close = `</${el.name}>`;
    const at = el.children[index].start;
    const made = parseXml(`${openTag}${close}`).children.find((c) => c.type === 'element');
    if (!made || made.name !== el.name) throw new Error('xml: split start tag does not match the element');
    this.#splice(at, at, close + openTag);
    offsetTree(made, at + close.length);
    made.closeStart = el.closeStart;
    made.end = el.end;
    el.closeStart = at;
    el.end = at + close.length;
    made.children = el.children.splice(index);
    for (const c of made.children) c.parent = made;
    made.parent = el.parent;
    el.parent.children.splice(el.parent.children.indexOf(el) + 1, 0, made);
    return made;
  }

  /** Change the value of an existing attribute. */
  setAttr(el, name, value) {
    const a = el.attrs.get(name);
    if (!a) throw new Error(`xml: <${el.name}> has no attribute ${name}`);
    if (a.value === value) return;
    const text = escapeAttr(value);
    const { start, end } = a;
    this.#splice(start, end, text, a);
    a.value = value;
    a.start = start;
    a.end = start + text.length;
  }

  #fragment(xml, base, parent) {
    const frag = parseXml(xml);
    const nodes = frag.children;
    for (const n of nodes) {
      n.parent = parent;
      offsetTree(n, base);
    }
    return nodes;
  }

  /** Replace [s, e) of the source and move every offset after it. */
  #splice(s, e, text, skipAttr = null) {
    const delta = text.length - (e - s);
    this.src = this.src.slice(0, s) + text + this.src.slice(e);
    this.edits++;
    if (delta === 0) return;
    const move = (p, kind, node) => {
      if (e > s) return p >= e ? p + delta : p;
      if (p !== s) return p > s ? p + delta : p;
      // An insertion at p: nodes starting there and the parent's end tag come after it.
      if (kind === 'start') return p + delta;
      if (kind === 'closeStart' && !node.selfClosing) return p + delta;
      return p;
    };
    const visit = (node) => {
      node.start = move(node.start, 'start', node);
      node.end = move(node.end, 'end', node);
      if (node.type !== 'element') return;
      node.openEnd = move(node.openEnd, 'openEnd', node);
      node.closeStart = move(node.closeStart, 'closeStart', node);
      for (const a of node.attrs.values()) {
        if (a === skipAttr) continue;
        a.start = move(a.start, 'attr', node);
        a.end = move(a.end, 'attr', node);
      }
      for (const c of node.children) visit(c);
    };
    // The root spans the whole document.
    this.root.end = this.root.closeStart = this.src.length;
    for (const c of this.root.children) visit(c);
  }
}

function offsetTree(node, base) {
  node.start += base;
  node.end += base;
  if (node.type !== 'element') return;
  node.openEnd += base;
  node.closeStart += base;
  for (const a of node.attrs.values()) { a.start += base; a.end += base; }
  for (const c of node.children) offsetTree(c, base);
}
