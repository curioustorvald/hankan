#!/usr/bin/env python3
"""Turn the KS X 6101 (OWPML) page saved from standard.go.kr into a Markdown
transcript, a JSON block model and the embedded images as files.

The saved page is not clean HTML, and an ordinary HTML parser would lose
content, so it is handled as follows:

  * XML examples and the XSD annexes are embedded as raw markup rather than
    escaped text. A small tokenizer treats only a fixed set of HTML tags as
    structure and keeps every other tag verbatim, with its original case
    (HTML parsers lower-case tag names).
  * The site's glossary linker wrapped matched words in pop-up markup, even
    in the middle of words ("이 <표>준") and inside XML attribute values.
    Every pop-up is replaced by the word it wrapped; its definition is
    dropped. Where the pop-up sat inside an attribute value, it had broken
    the surrounding tag in one of two ways (entity-escaped, or split by an
    HTML parser); both are reduced to the wrapped word as well.
  * Every paragraph is followed by an "AI추천문서" list of unrelated
    standards; those lists are removed.
  * Part of the page was re-serialised by an HTML parser before it was
    saved. In the XML examples there, element and attribute names are lower
    case, straight quotes were added around the document's own curly quotes
    and self-closing tags were expanded. That cannot be undone reliably, so
    the examples are kept as found and flagged with a note; the extraction
    report lists the affected names. The XSD annexes are not affected.
  * The private-use character U+F53A is the old-Hangul syllable ᄒᆞᆫ (as in
    the spec PDFs) and is mapped to it.
  * Symbol-font private-use characters (U+F020–U+F0FF in <span
    class="Symbol">) are mapped to Unicode via the Adobe Symbol encoding.
"""
import argparse
import base64
import collections
import hashlib
import html
import json
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdf2md import md_table  # noqa: E402

STRUCT = {"div", "p", "span", "a", "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th", "br",
          "b", "strong", "i", "em", "u", "sub", "sup", "font", "h1", "h2", "h3", "h4", "h5", "h6", "img"}
INLINE = {"span", "a", "b", "strong", "i", "em", "u", "font", "sub", "sup"}
BLOCK = {"div", "p", "ul", "ol", "table", "h1", "h2", "h3", "h4", "h5", "h6"}
HAN = "ᄒᆞᆫ"  # ᄒᆞᆫ
TOKEN = re.compile(r"<!--.*?-->|<[^<>]*>|[^<]+|<", re.S)

# Adobe Symbol encoding, for the code points the Symbol font remaps into
# U+F020–U+F0FF. Codes not listed map to the same ASCII character.
_SYMBOL_CODES = ([0x22, 0x24, 0x27, 0x2A, 0x2D, 0x40, 0x5C, 0x5E, 0x7E] + list(range(0x41, 0x5B))
                 + list(range(0x61, 0x7B)) + list(range(0xA1, 0xF0)) + list(range(0xF1, 0xFF)))
_SYMBOL_CHARS = ("∀∃∋∗−≅∴⊥∼"
                 "ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ"
                 "αβχδεφγηιϕκλμνοπθρστυϖωξψζ"
                 "ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓°±″≥×∝∂•÷≠≡≈…⏐⎯↵"
                 "ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓"
                 "◊〈®©™∑⎛⎜⎝⎡⎢⎣⎧⎨⎩⎪"
                 "〉∫⌠⎮⌡⎞⎟⎠⎤⎥⎦⎫⎬⎭")
assert len(_SYMBOL_CODES) == len(_SYMBOL_CHARS)
SYMBOL = dict(zip(_SYMBOL_CODES, _SYMBOL_CHARS))

POPUP = re.compile(r"""<div class=(['"])jb-container\1><div class=(['"])jb-title\2>((?:(?!<div).)*?)</div>"""
                   r"""<div class=(['"])jb-text\4>(?:(?!<div).)*?</div></div>""", re.S)
POPUP_ESCAPED = re.compile(r"&lt;div class='jb-container'&gt;&lt;div class='jb-title'&gt;(.*?)&lt;/div&gt;"
                           r"&lt;div class='jb-text'&gt;(?:(?!&lt;div).)*?&lt;/div&gt;&lt;/div&gt;", re.S)
POPUP_SPLIT = re.compile(r'"“&lt;div" class="jb-container"><div class="jb-title">([^<]*)</div>'
                         r'<div class="jb-text">(?:(?!</div>).)*</div>', re.S)
AI_LIST = re.compile(r"""<div class=(['"])jb-serach-text\1>\s*<p>(?:<font>)*AI추천문서(?:</font>)*</p>\s*"""
                     r"""<ul>.*?</ul>\s*</div>""", re.S)

DEGRADED_NOTE = ("<!-- note: this example sits in the part of the saved page that an HTML parser re-serialised: "
                 "element/attribute names were lower-cased, quotes doubled and self-closing tags expanded. "
                 "Use the XSD annexes for exact names. -->")


def clean(s, report):
    s, report["popups_escaped"] = POPUP_ESCAPED.subn(r"\1", s)
    s, report["popups_split"] = POPUP_SPLIT.subn(r'"“\1', s)
    total = 0
    while True:  # innermost first: pop-up definitions contain pop-ups too
        s, n = POPUP.subn(r"\3", s)
        total += n
        if not n:
            break
    report["popups"] = total
    s, report["ai_lists_removed"] = AI_LIST.subn("", s)
    report["leftover_jb_markup"] = len(re.findall(r"jb-(?:container|title|text)\b|AI추천문서", s))
    return s


class Node:
    __slots__ = ("tag", "attrs", "children")

    def __init__(self, tag, attrs=""):
        self.tag, self.attrs, self.children = tag, attrs, []

    def attr(self, name):
        m = re.search(r"""\b%s\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""" % name, self.attrs)
        return next((g for g in m.groups() if g is not None), "") if m else ""


class Literal(str):
    """Markup that is content (an XML example tag), kept verbatim."""


def parse(s):
    root = Node("root")
    stack = [root]
    for m in TOKEN.finditer(s):
        tok = m.group(0)
        if tok.startswith("<!--"):
            stack[-1].children.append(Literal(re.sub(r"<[^>]*>", "", tok)))
            continue
        tm = re.match(r"<(/?)\s*([A-Za-z][\w:.-]*)(.*?)(/?)>$", tok, re.S) if tok.startswith("<") else None
        name = tm.group(2).lower() if tm else None
        if tm is None or name not in STRUCT or ":" in tm.group(2) or (name == "img" and "src=" not in tok):
            if tok.startswith("<"):
                stack[-1].children.append(Literal(tok))
            else:
                stack[-1].children.append(html.unescape(tok).replace("", HAN))
            continue
        closing, attrs = tm.group(1), tm.group(3)
        if name == "br":
            stack[-1].children.append(Node("br"))
        elif closing:
            if any(n.tag == name for n in stack[1:]):
                while stack.pop().tag != name:
                    pass
        else:
            if name in ("td", "th", "li", "p") and stack[-1].tag == name:
                stack.pop()
            if name == "tr":
                while stack[-1].tag in ("td", "th", "tr"):
                    stack.pop()
            node = Node(name, attrs)
            stack[-1].children.append(node)
            if name != "img" and not tm.group(4):
                stack.append(node)
    return root


class Renderer:
    def __init__(self, out, name):
        self.out, self.name = out, name
        self.images = []
        self.symbol_unmapped = collections.Counter()

    def image(self, node):
        src = node.attr("src")
        m = re.match(r"data:([\w/+.-]+)(;base64)?,(.*)", src, re.S)
        if not m:
            return f"[image: {src}]"
        data = base64.b64decode(m.group(3)) if m.group(2) else urllib.parse.unquote(m.group(3)).encode("utf-8")
        ext = {"image/jpeg": "jpg", "image/png": "png", "image/svg+xml": "svg", "image/gif": "gif"}.get(m.group(1), "bin")
        path = f"{self.name}/img/{len(self.images) + 1:03d}.{ext}"
        with open(os.path.join(self.out, path), "wb") as fh:
            fh.write(data)
        self.images.append({"path": path, "alt": node.attr("alt"), "bytes": len(data)})
        return f"![{node.attr('alt')}]({path})"

    def inline(self, node, code=False):
        """Text of a node's content; <br> becomes a newline."""
        parts = []
        for ch in node.children:
            if isinstance(ch, Literal):
                parts.append(str(ch))
            elif isinstance(ch, str):
                parts.append(ch.replace("\xa0", " ") if code else re.sub(r"[\s\xa0]+", " ", ch))
            elif ch.tag == "br":
                parts.append("\n")
            elif ch.tag == "img":
                parts.append(self.image(ch))
            elif ch.tag == "span" and ch.attr("class") == "Symbol":
                parts.append(self.symbol(self.inline(ch, code)))
            elif ch.tag in ("sub", "sup"):
                parts.append(f"<{ch.tag}>{self.inline(ch, code)}</{ch.tag}>")
            else:
                parts.append(self.inline(ch, code))
        return "".join(parts)

    def symbol(self, text):
        out = []
        for c in text:
            if 0xF020 <= ord(c) <= 0xF0FF:
                low = ord(c) - 0xF000
                if low in SYMBOL:
                    c = SYMBOL[low]
                elif 0x20 <= low < 0x7F:
                    c = chr(low)
                else:
                    self.symbol_unmapped[f"U+{ord(c):04X}"] += 1
            out.append(c)
        return "".join(out)

    def table(self, node):
        rows = [tr for tr in walk(node, stop={"table"}) if tr.tag == "tr"]
        cells, taken = [], set()
        for r, tr in enumerate(rows):
            c = 0
            for td in (ch for ch in tr.children if isinstance(ch, Node) and ch.tag in ("td", "th")):
                while (r, c) in taken:
                    c += 1
                rs = int(td.attr("rowspan") or 1)
                cs = int(td.attr("colspan") or 1)
                for i in range(r, r + rs):
                    for j in range(c, c + cs):
                        taken.add((i, j))
                code = has_literal(td)
                text = self.inline(td, code)
                text = "\n".join(l.rstrip() if code else l.strip() for l in text.split("\n")).strip("\n")
                cells.append({"row": r, "col": c, "rowspan": rs, "colspan": cs, "text": text, "markup": code})
                c += cs
        nrows = max((r for r, _ in taken), default=-1) + 1
        ncols = max((c for _, c in taken), default=-1) + 1
        return {"type": "table", "nrows": nrows, "ncols": ncols, "cells": cells}


def walk(node, stop=()):
    for ch in node.children:
        if isinstance(ch, Node):
            yield ch
            if ch.tag not in stop:
                yield from walk(ch, stop)


def has_block(node, memo={}):
    """Does an inline element contain block-level content? (The re-serialised
    part of the page wraps whole sections, tables included, in <font>.)"""
    if id(node) not in memo:
        memo[id(node)] = any(isinstance(ch, Node) and (ch.tag in BLOCK or has_block(ch)) for ch in node.children)
    return memo[id(node)]


def has_literal(node):
    return any(isinstance(ch, Literal) for ch in node.children) or \
        any(has_literal(ch) for ch in node.children if isinstance(ch, Node))


def heading_number(hid):
    m = re.fullmatch(r"title([A-Z0-9][\w.]*)", hid or "")
    return m.group(1) if m else None


def blocks_of(root, r):
    """Flatten the tree into headings, paragraphs, lists, tables and code."""
    blocks, buf, section = [], [], None

    def flush():
        text = "\n".join(l.strip() for l in "".join(buf).split("\n")).strip()
        if text:
            blocks.append({"type": "paragraph", "section": section, "text": re.sub(r"\n{2,}", "\n", text)})
        buf.clear()

    def visit(node):
        nonlocal section
        for ch in node.children:
            if not isinstance(ch, Node) or (ch.tag in INLINE and not has_block(ch)) or ch.tag in ("br", "img"):
                tmp = Node("tmp")
                tmp.children = [ch]
                buf.append(r.inline(tmp))
                continue
            if ch.tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
                flush()
                num = heading_number(ch.attr("id"))
                level = 1 if ch.tag == "h1" else min(6, num.count(".") + 1) if num else 2
                text = re.sub(r"\s+", " ", r.inline(ch)).strip()
                section = num or ch.attr("id")
                blocks.append({"type": "heading", "level": level, "id": ch.attr("id"), "number": num,
                               "text": (num + " " if num else "") + text})
            elif ch.tag == "table":
                flush()
                t = r.table(ch)
                t["section"] = section
                blocks.append(t)
            elif ch.tag in ("ul", "ol"):
                flush()
                items = [re.sub(r"[ \t]+", " ", r.inline(li)).strip() for li in ch.children
                         if isinstance(li, Node) and li.tag == "li"]
                blocks.append({"type": "list", "section": section, "items": items})
            else:  # div, p, li/td outside their containers
                flush()
                visit(ch)
                flush()

    visit(root)
    flush()
    return blocks


def degraded_names(text, camel):
    """Lower-case XML names in an example whose camel-case form the document
    uses elsewhere: the trace of the HTML re-serialisation."""
    names = re.findall(r"</?([\w:.-]+)", text) + re.findall(r"\s([\w:.-]+)=", text)
    return sorted({n for n in names if n == n.lower() and camel.get(n, n) != n})


def render(blocks, src, sha, camel):
    out = [
        "<!--",
        f"Transcript of: {src}",
        f"SHA-256:       {sha}",
        "Generated by:  tools/spec/owpml_html2md.py — do not edit; regenerate instead.",
        "Conventions:   see README.md next to this file.",
        "-->",
    ]
    for b in blocks:
        if b["type"] == "heading":
            out.append("\n" + "#" * b["level"] + " " + b["text"])
        elif b["type"] == "paragraph":
            out.append("\n" + b["text"])
        elif b["type"] == "list":
            out.append("\n" + "\n".join("- " + i.replace("\n", "\n  ") for i in b["items"]))
        elif b["type"] == "table":
            if b["nrows"] == 1 and b["ncols"] == 1 and b["cells"][0]["markup"]:
                code = b["cells"][0]["text"]
                if b.get("degraded"):
                    out.append("\n" + DEGRADED_NOTE)
                out.append("\n```xml\n" + code + "\n```")
            elif b["nrows"] and b["ncols"]:
                if b.get("degraded"):
                    out.append("\n" + DEGRADED_NOTE)
                out.append("\n" + md_table(b))
    return "\n".join(out).lstrip("\n") + "\n"


def write_annex_schemas(blocks, out, name):
    """Write the schema listings of the normative annexes ("(규정)… XML
    스키마") as .xsd files and check that each is well-formed XML."""
    import xml.etree.ElementTree as ET
    results, annex, code = [], None, []

    def finish():
        if annex and code and code[0].lstrip().startswith("<?xml"):
            slug = re.sub(r"\W+", "-", re.sub(r"\(규정\)|XML 스키마", "", annex["text"].split(" ", 1)[1])).strip("-").lower()
            path = f"{name}/xsd/annex-{annex['number']}-{slug}.xsd"
            text = "\n".join(code) + "\n"
            os.makedirs(os.path.join(out, name, "xsd"), exist_ok=True)
            with open(os.path.join(out, path), "w", encoding="utf-8") as fh:
                fh.write(text)
            try:
                ET.fromstring(text.encode("utf-8"))
                err = None
            except ET.ParseError as e:
                err = str(e)
            results.append({"annex": annex["number"], "path": path, "well_formed": err is None, "error": err})

    for b in blocks:
        if b["type"] == "heading" and b["level"] == 1:
            finish()
            annex, code = (b if "(규정)" in b["text"] and "스키마" in b["text"] else None), []
        elif annex and b["type"] == "table" and b["nrows"] == b["ncols"] == 1 and b["cells"][0]["markup"]:
            code.append(b["cells"][0]["text"])
    finish()
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("html")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--name", required=True, help="short output name, e.g. owpml")
    a = ap.parse_args()

    with open(a.html, "rb") as fh:
        raw = fh.read()
    sha = hashlib.sha256(raw).hexdigest()
    report = {}
    s = clean(raw.decode("utf-8"), report)
    os.makedirs(os.path.join(a.out, a.name, "img"), exist_ok=True)
    r = Renderer(a.out, a.name)
    blocks = blocks_of(parse(s), r)

    # Names the document spells in camel case somewhere, keyed by lower case.
    camel = {}
    for m in re.finditer(r"<[\w:.-]*[A-Z][\w:.-]*|\s[\w:.-]*[A-Z][\w:.-]*=", s):
        n = m.group(0).lstrip("<").strip().rstrip("=")
        local = n.split(":")[-1]
        if re.search("[a-z]", local) and re.search("[A-Z]", local[1:]):  # camelCase, not Capitalised/CAPS
            camel.setdefault(n.lower(), n)
    degraded = collections.Counter()
    for b in blocks:
        if b["type"] == "table" and any(c["markup"] for c in b["cells"]):
            names = set()
            for c in b["cells"]:
                names.update(degraded_names(c["text"], camel))
            if names or any('="“' in c["text"] for c in b["cells"]):
                b["degraded"] = sorted(names)
                degraded.update(names)
    report["degraded_examples"] = sum(1 for b in blocks if b.get("degraded") is not None)
    report["lowercased_names"] = {n: camel[n] for n in sorted(degraded)}
    report["symbol_unmapped"] = dict(r.symbol_unmapped)
    pua = collections.Counter(c for b in blocks for t in [json.dumps(b, ensure_ascii=False)] for c in t
                              if 0xE000 <= ord(c) <= 0xF8FF)
    report["pua_left"] = {f"U+{ord(c):04X}": n for c, n in pua.items()}

    report["xsd"] = write_annex_schemas(blocks, a.out, a.name)

    with open(os.path.join(a.out, a.name + ".md"), "w", encoding="utf-8") as fh:
        fh.write(render(blocks, os.path.relpath(a.html), sha, camel))
    doc = {"source": {"path": os.path.relpath(a.html), "sha256": sha}, "generator": "tools/spec/owpml_html2md.py",
           "report": report, "images": r.images,
           "index": {"headings": [{k: b[k] for k in ("level", "id", "number", "text")} for b in blocks
                                  if b["type"] == "heading"]},
           "blocks": blocks}
    with open(os.path.join(a.out, a.name + ".json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
    counts = collections.Counter(b["type"] for b in blocks)
    print(f"{a.name}: {dict(counts)}, {len(r.images)} images, report "
          f"{ {k: v for k, v in report.items() if k != 'lowercased_names'} }, "
          f"{len(report['lowercased_names'])} lower-cased names", file=sys.stderr)


if __name__ == "__main__":
    main()
