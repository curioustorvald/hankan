#!/usr/bin/env python3
"""Turn one spec-sheet PDF into a Markdown transcript, a JSON block model and
per-page PNG renders.

Glyphs and their positions come from `mutool draw -F stext`; table ruling
lines come from `mutool draw -F trace`. This is a generic layout-to-text
converter tuned to the page layout of the spec PDFs; it carries no knowledge
of the file formats those PDFs describe.

What it does, in order:
  * groups glyphs into lines by baseline, keeping the source line breaks
    (a line break in the PDF may fall inside a word, so lines are never
    re-flowed);
  * rebuilds tables from horizontal/vertical rules, treating a missing
    interior rule as a merged cell, and joins a table that runs over a page
    break with its continuation (dropping a repeated header row);
  * strips the running header/footer (a line near the top or bottom edge
    that recurs on many pages), recording the printed page number;
  * marks where raster images sit with an "[image]" token, inside the
    table cell when the image is in one;
  * marks numbered bold lines as headings and indexes "표 N"/"그림 N"
    captions;
  * maps the one private-use glyph the PDFs use (U+F53A, and the same glyph
    when it has no Unicode mapping at all) to the old-Hangul syllable
    ᄒᆞᆫ, and the Wingdings bullet to ▪.
"""
import argparse
import bisect
import collections
import hashlib
import html
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

HAN = "\u1112\u119e\u11ab"  # ᄒᆞᆫ
PUA = {"\uf53a": HAN}
WINGDINGS = {"§": "\u25aa"}  # the bullet glyph in Wingdings → ▪

HEADER_FRAC = 0.10   # running headers live above this fraction of the page
FOOTER_FRAC = 0.93   # running footers (page numbers) live below this one
SNAP = 2.5           # rules closer than this (pt) are the same grid line
TOUCH = 1.5          # rules within this distance (pt) are connected

HEADING_RE = re.compile(r"^(?:([IVX]+)\.|((?:\d+\.)+\d*\.?))\s*\S")
CAPTION_RE = re.compile(r"^(표|그림)\s*(\d+)\s+\S")


def mutool(*args):
    return subprocess.run(["mutool", *args], check=True, capture_output=True).stdout


def valid_xml_charrefs(s):
    """mutool writes &#xffff; for glyphs without a Unicode mapping, which is
    not a legal XML character; turn every such reference into U+FFFD."""
    def fix(m):
        cp = int(m.group(1), 16)
        ok = cp in (0x9, 0xA, 0xD) or 0x20 <= cp <= 0xD7FF or 0xE000 <= cp <= 0xFFFD or cp >= 0x10000
        return m.group(0) if ok else "&#xfffd;"
    return re.sub(r"&#x([0-9a-fA-F]+);", fix, s)


class Char:
    __slots__ = ("c", "x", "y", "x0", "x1", "y0", "y1", "size", "bold", "font")

    def __init__(self, c, x, y, quad, size, font):
        q = [float(v) for v in quad.split()] if isinstance(quad, str) else quad
        self.c, self.x, self.y = c, x, y
        self.x0, self.x1 = min(q[0::2]), max(q[0::2])
        self.y0, self.y1 = min(q[1::2]), max(q[1::2])
        self.size, self.font = size, font
        self.bold = "Bold" in font or font.endswith("-B")

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2

    @property
    def cy(self):
        return self.y - 0.3 * self.size


def read_chars(pdf):
    """Return {page number: (width, height, [Char])} and a tally of glyph fixes."""
    root = ET.fromstring(valid_xml_charrefs(mutool("draw", "-q", "-F", "stext", "-o", "-", pdf).decode("utf-8")))
    pages, fixes = {}, collections.Counter()
    for n, page in enumerate(root.iter("page"), 1):
        chars = []
        for font in page.iter("font"):
            name, size = font.get("name") or "", float(font.get("size"))
            for ch in font.iter("char"):
                c = ch.get("c")
                if c in PUA:
                    fixes[f"U+{ord(c):04X}→{PUA[c]}"] += 1
                    c = PUA[c]
                elif "Wingdings" in name and c in WINGDINGS:
                    c = WINGDINGS[c]
                chars.append(Char(c, float(ch.get("x")), float(ch.get("y")), ch.get("quad"), size, name))
        # An unmapped glyph right before 글 is the same ᄒᆞᆫ glyph, just
        # embedded without a ToUnicode entry.
        chars.sort(key=lambda ch: (round(ch.y, 1), ch.x))
        for i, ch in enumerate(chars):
            if ch.c == "\ufffd" and i + 1 < len(chars) and chars[i + 1].c == "글":
                ch.c = HAN
                fixes["unmapped glyph before 글→" + HAN] += 1
        pages[n] = (float(page.get("width")), float(page.get("height")), chars)
    return pages, fixes


def read_rules(pdf):
    """Return {page number: ([(y, x0, x1)], [(x, y0, y1)], [(x0, y0, x1, y1)])}:
    the axis-aligned horizontal and vertical rules and the image placements
    on each page, in page space."""
    pages = collections.defaultdict(lambda: ([], [], []))
    page = cur = None
    num = r'"(-?[\d.]+)"'
    for line in mutool("draw", "-q", "-F", "trace", "-o", "-", pdf).decode("utf-8", "replace").splitlines():
        s = line.strip()
        if s.startswith("<page "):
            page = int(re.search(r'number="(\d+)"', s).group(1))
        elif s.startswith("<fill_image"):
            a, b, c, d, e, f = [float(v) for v in re.search(r'transform="([^"]*)"', s).group(1).split()]
            xs, ys = [e, a + e, c + e, a + c + e], [f, b + f, d + f, b + d + f]
            pages[page][2].append((min(xs), min(ys), max(xs), max(ys)))
        elif s.startswith(("<stroke_path", "<fill_path")) and not s.endswith("/>"):
            color = re.search(r'color="([^"]*)"', s).group(1).split()
            white = all(float(v) == 1 for v in color) if "DeviceCMYK" not in s else all(float(v) == 0 for v in color)
            t = [float(v) for v in re.search(r'transform="([^"]*)"', s).group(1).split()]
            cur = {"stroke": s.startswith("<stroke"), "skip": white, "t": t, "subs": []}
        elif cur is not None and s.startswith(("<moveto", "<lineto", "<curveto")):
            xs = [float(v) for v in re.findall(r'x\d?=' + num, s)]
            ys = [float(v) for v in re.findall(r'y\d?=' + num, s)]
            a, b, c, d, e, f = cur["t"]
            pt = (a * xs[-1] + c * ys[-1] + e, b * xs[-1] + d * ys[-1] + f, s.startswith("<curveto"))
            if s.startswith("<moveto"):
                cur["subs"].append([pt])
            elif cur["subs"]:
                cur["subs"][-1].append(pt)
        elif cur is not None and s.startswith("<closepath") and cur["subs"]:
            sub = cur["subs"][-1]
            sub.append((sub[0][0], sub[0][1], False))
        elif cur is not None and s.startswith(("</stroke_path", "</fill_path")):
            if not cur["skip"]:
                hs, vs, _ = pages[page]
                for sub in cur["subs"]:
                    if cur["stroke"]:
                        for (xa, ya, _), (xb, yb, curved) in zip(sub, sub[1:]):
                            if curved:
                                continue
                            if abs(ya - yb) < 0.5 and abs(xa - xb) > 2:
                                hs.append(((ya + yb) / 2, min(xa, xb), max(xa, xb)))
                            elif abs(xa - xb) < 0.5 and abs(ya - yb) > 2:
                                vs.append(((xa + xb) / 2, min(ya, yb), max(ya, yb)))
                    elif 4 <= len(sub) <= 6 and not any(p[2] for p in sub):
                        # A thin filled rectangle is a rule drawn as a fill.
                        x0, x1 = min(p[0] for p in sub), max(p[0] for p in sub)
                        y0, y1 = min(p[1] for p in sub), max(p[1] for p in sub)
                        if y1 - y0 <= 2 < x1 - x0:
                            hs.append(((y0 + y1) / 2, x0, x1))
                        elif x1 - x0 <= 2 < y1 - y0:
                            vs.append(((x0 + x1) / 2, y0, y1))
            cur = None
    return pages


def merge_rules(rules):
    """Merge collinear, touching rules: [(pos, a, b)] → fewer, longer ones."""
    out = []
    for pos, a, b in sorted(rules):
        for r in out:
            if abs(r[0] - pos) <= 0.8 and a <= r[2] + 1.0 and b >= r[1] - 1.0:
                r[1], r[2] = min(r[1], a), max(r[2], b)
                break
        else:
            out.append([pos, a, b])
    return out


def snap(values):
    """Cluster sorted coordinates that lie within SNAP of each other."""
    groups = []
    for v in sorted(values):
        if groups and v - groups[-1][-1] <= SNAP:
            groups[-1].append(v)
        else:
            groups.append([v])
    return [sum(g) / len(g) for g in groups]


def find_tables(hs, vs):
    """Group connected rules into tables; return [(xs, ys, hs, vs)]."""
    hs, vs = merge_rules(hs), merge_rules(vs)
    segs = [("h", *r) for r in hs] + [("v", *r) for r in vs]
    parent = list(range(len(segs)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, (k1, p1, a1, b1) in enumerate(segs):
        for j in range(i + 1, len(segs)):
            k2, p2, a2, b2 = segs[j]
            if k1 == k2:
                continue
            if a1 - TOUCH <= p2 <= b1 + TOUCH and a2 - TOUCH <= p1 <= b2 + TOUCH:
                parent[find(i)] = find(j)
    comps = collections.defaultdict(list)
    for i, s in enumerate(segs):
        comps[find(i)].append(s)
    tables = []
    for comp in comps.values():
        th = [s[1:] for s in comp if s[0] == "h"]
        tv = [s[1:] for s in comp if s[0] == "v"]
        if len(th) < 2 or not tv:
            continue
        left, right = min(min(h[1] for h in th), min(v[0] for v in tv)), max(max(h[2] for h in th), max(v[0] for v in tv))
        top, bottom = min(min(v[1] for v in tv), min(h[0] for h in th)), max(max(v[2] for v in tv), max(h[0] for h in th))
        if right - left < 30 or bottom - top < 8:
            continue
        xs = snap([v[0] for v in tv] + [left, right])
        ys = snap([h[0] for h in th] + [top, bottom])
        if len(xs) >= 2 and len(ys) >= 2:
            tables.append((xs, ys, th, tv))
    return tables


def covered(rules, pos, a, b):
    """Is the span a..b at coordinate pos mostly drawn by some rule?"""
    got = sum(max(0, min(b, r[2]) - max(a, r[1])) for r in rules if abs(r[0] - pos) <= SNAP)
    return got >= 0.6 * (b - a)


def build_cells(xs, ys, th, tv):
    """Return [(row, col, rowspan, colspan)] for the grid, merging cells
    whose shared border is not drawn."""
    nr, nc = len(ys) - 1, len(xs) - 1
    parent = {(r, c): (r, c) for r in range(nr) for c in range(nc)}

    def find(k):
        while parent[k] != k:
            k = parent[k]
        return k

    for r in range(nr):
        for c in range(nc):
            if c + 1 < nc and not covered(tv, xs[c + 1], ys[r], ys[r + 1]):
                parent[find((r, c + 1))] = find((r, c))
            if r + 1 < nr and not covered(th, ys[r + 1], xs[c], xs[c + 1]):
                parent[find((r + 1, c))] = find((r, c))
    groups = collections.defaultdict(list)
    for k in parent:
        groups[find(k)].append(k)
    cells, owner, irregular = [], {}, 0
    for members in sorted(groups.values(), key=min):
        r0, r1 = min(m[0] for m in members), max(m[0] for m in members)
        c0, c1 = min(m[1] for m in members), max(m[1] for m in members)
        if len(members) != (r1 - r0 + 1) * (c1 - c0 + 1):
            irregular += 1
        cells.append((r0, c0, r1 - r0 + 1, c1 - c0 + 1))
    for i, (r0, c0, rs, cs) in enumerate(cells):
        for r in range(r0, r0 + rs):
            for c in range(c0, c0 + cs):
                owner.setdefault((r, c), i)
    return cells, owner, irregular


def prune_empty_rows(cells, nrows):
    """Drop grid rows that no text-bearing cell covers (connector lines of a
    diagram drawn around a table produce those), shrinking spans to match."""
    keep = [any(c["text"] and c["row"] <= r < c["row"] + c["rowspan"] for c in cells) for r in range(nrows)]
    new = [sum(keep[:r]) for r in range(nrows)]
    out = []
    for c in cells:
        span = sum(keep[c["row"]:c["row"] + c["rowspan"]])
        if span:
            first = next(r for r in range(c["row"], c["row"] + c["rowspan"]) if keep[r])
            out.append(dict(c, row=new[first], rowspan=span))
    return out, sum(keep)


def line_groups(chars):
    """Group glyphs into lines by baseline; return [[Char]] top to bottom."""
    lines = []
    for ch in sorted(chars, key=lambda ch: (ch.y, ch.x)):
        if lines and abs(ch.y - lines[-1][0].y) <= 0.45 * max(ch.size, lines[-1][0].size):
            lines[-1].append(ch)
        else:
            lines.append([ch])
    return [sorted(l, key=lambda ch: ch.x) for l in lines]


def line_text(chars, column_gaps=True):
    out, prev, space = [], None, False
    for ch in chars:
        if ch.c.isspace():
            space = True
            continue
        if prev is not None:
            gap, em = ch.x0 - prev.x1, max(ch.size, prev.size)
            if column_gaps and gap > 1.8 * em:
                out.append("    ")
            elif space or gap > 0.3 * em:
                out.append(" ")
        out.append(ch.c)
        prev, space = ch, False
    text = "".join(out)
    return re.sub(r"·{3,}", " … ", text)  # table-of-contents dot leaders


def body_size(pages):
    sizes = collections.Counter()
    for _, _, chars in pages.values():
        for ch in chars:
            sizes[round(ch.size, 1)] += 1
    return sizes.most_common(1)[0][0]


def classify(line, text, body):
    """Return ('heading', level) / ('caption', None) / ('text', None)."""
    glyphs = [ch for ch in line if not ch.c.isspace()]
    if not glyphs or re.search(r"…\s*\d+$", text):  # table-of-contents entry
        return "text", None
    bold = sum(ch.bold for ch in glyphs) >= 0.8 * len(glyphs)
    size = max(ch.size for ch in glyphs)
    m = HEADING_RE.match(text)
    if m and bold and len(text) <= 80 and size >= 0.95 * body:
        level = 1 if m.group(1) else 1 + m.group(2).rstrip(".").count(".") + 1
        return "heading", min(level, 6)
    if bold and size >= 1.2 * body and len(text) <= 40 and text[0] not in "▪•·-":
        return "heading", 1
    if CAPTION_RE.match(text) and len(text) <= 100:
        return "caption", None
    return "text", None


def furniture_key(line, height):
    """Normalised text of a line close enough to the top or bottom edge to be
    a running header/footer, else None."""
    if HEADER_FRAC * height < line[0].y < FOOTER_FRAC * height:
        return None
    return ("top " if line[0].y < height / 2 else "bottom ") + re.sub(r"\d+", "#", re.sub(r"\s+", "", line_text(line)))


def find_furniture(pages):
    """Keys of edge lines that recur on enough pages to be running heads."""
    seen = collections.Counter()
    for _, h, chars in pages.values():
        seen.update({furniture_key(l, h) for l in line_groups(chars)} - {None})
    need = max(3, 0.25 * len(pages))
    return {k for k, v in seen.items() if v >= need and k.split(" ", 1)[1]}


def page_blocks(n, width, height, chars, rules, body, furniture):
    """Lay out one page as an ordered list of blocks."""
    top, bottom, dropped, body_chars = 0, height, [], []
    for line in line_groups(chars):
        if furniture_key(line, height) in furniture:
            dropped.append(line_text(line))
            if line[0].y < height / 2:
                top = max(top, max(ch.y1 for ch in line) + 1)
            else:
                bottom = min(bottom, min(ch.y0 for ch in line) - 1)
        else:
            body_chars += line
    printed = next((t for t in dropped if re.fullmatch(r"\d+", t.strip())), None)

    hs, vs, images = rules.get(n, ([], [], []))
    hs = [h for h in hs if top <= h[0] <= bottom]
    vs = [v for v in vs if v[2] >= top and v[1] <= bottom]
    for x0, y0, x1, y1 in images:
        if y0 >= top and y1 <= bottom and min(x1 - x0, y1 - y0) >= 4:
            cy = (y0 + y1) / 2
            body_chars.append(Char("[image]", x0, cy + 3, [x0, cy - 3, x1, cy + 3], 10.0, ""))
    blocks, irregular = [], 0
    for xs, ys, th, tv in find_tables(hs, vs):
        cells, owner, irr = build_cells(xs, ys, th, tv)
        irregular += irr
        content = collections.defaultdict(list)
        rest = []
        for ch in body_chars:
            if xs[0] - 1 <= ch.cx <= xs[-1] + 1 and ys[0] - 1 <= ch.cy <= ys[-1] + 1:
                r = min(max(bisect.bisect_right(ys, ch.cy) - 1, 0), len(ys) - 2)
                c = min(max(bisect.bisect_right(xs, ch.cx) - 1, 0), len(xs) - 2)
                content[owner[(r, c)]].append(ch)
            else:
                rest.append(ch)
        body_chars = rest
        out = []
        for i, (r, c, rs, cs) in enumerate(cells):
            text = "\n".join(t for t in (line_text(l, False) for l in line_groups(content[i])) if t)
            out.append({"row": r, "col": c, "rowspan": rs, "colspan": cs, "text": text})
        out, nrows = prune_empty_rows(out, len(ys) - 1)
        if not out:
            continue  # an empty frame, e.g. around a vector drawing
        blocks.append({"type": "table", "page": n, "y": ys[0],
                       "bbox": [round(xs[0], 1), round(ys[0], 1), round(xs[-1], 1), round(ys[-1], 1)],
                       "cols": [round(x, 1) for x in xs], "nrows": nrows, "ncols": len(xs) - 1,
                       "cells": out})

    # Free text: lines, then paragraphs separated by vertical gaps.
    para = None
    for line in line_groups(body_chars):
        text = line_text(line)
        if not text.strip():
            continue
        kind, level = classify(line, text.strip(), body)
        y, size = line[0].y, max(ch.size for ch in line)
        if kind == "text" and para and para["type"] == "paragraph" and y - para["_last"] <= 1.9 * size:
            para["lines"].append(text.strip())
            para["_last"] = y
            continue
        para = {"type": "paragraph" if kind == "text" else kind, "page": n, "y": y - size, "_last": y}
        if kind == "heading":
            para.update(level=level, text=text.strip())
        elif kind == "caption":
            m = CAPTION_RE.match(text.strip())
            para.update(kind=m.group(1), number=int(m.group(2)), text=text.strip())
        else:
            para["lines"] = [text.strip()]
        blocks.append(para)
    blocks.sort(key=lambda b: b["y"])
    for b in blocks:
        b.pop("_last", None)
    return blocks, {"page": n, "printed": printed, "dropped": [t for t in dropped if t.strip()]}, irregular


def join_continued_tables(blocks):
    """Merge a table that ends a page with the table that starts the next
    page when their column rules line up; drop a repeated header row."""
    out = []
    for b in blocks:
        prev = out[-1] if out else None
        if (b["type"] == "table" and prev is not None and prev["type"] == "table"
                and b["page"] == prev["pages"][-1] + 1 and len(b["cols"]) == len(prev["cols"])
                and all(abs(p - q) <= 3 for p, q in zip(b["cols"], prev["cols"]))):
            def row(t, r):
                return [c["text"] for c in t["cells"] if c["row"] == r]
            skip = 1 if row(b, 0) == row(prev, 0) and b["nrows"] > 1 else 0
            # A row split by the page break continues with its first column
            # empty: append its text to the row it continues.
            first = [c for c in b["cells"] if c["row"] == skip]
            last = prev["nrows"] - 1
            if (b["nrows"] > skip and any(c["text"] for c in first)
                    and all(not c["text"] for c in first if c["col"] == 0)
                    and any(c["text"] for c in prev["cells"] if c["col"] == 0 and c["row"] <= last < c["row"] + c["rowspan"])):
                for c in first:
                    host = next((p for p in prev["cells"] if p["row"] <= last < p["row"] + p["rowspan"]
                                 and p["col"] <= c["col"] < p["col"] + p["colspan"]), None)
                    if host is not None and c["text"]:
                        host["text"] = (host["text"] + "\n" + c["text"]).strip("\n")
                prev["split_rows"] = prev.get("split_rows", 0) + 1
                skip += 1
            off = prev["nrows"] - skip
            for c in b["cells"]:
                if c["row"] >= skip and c["row"] + c["rowspan"] > skip:
                    first_row = max(c["row"], skip)
                    prev["cells"].append(dict(c, row=first_row + off, rowspan=c["row"] + c["rowspan"] - first_row))
            prev["nrows"] += b["nrows"] - skip
            prev["pages"].append(b["page"])
            continue
        if b["type"] == "table":
            b["pages"] = [b["page"]]
        out.append(b)
    return out


def attach_captions(blocks):
    for i, b in enumerate(blocks):
        if b["type"] == "caption" and b["kind"] == "표" and i and blocks[i - 1]["type"] == "table":
            blocks[i - 1]["caption"] = b["text"]


def md_cell(text):
    return text.replace("|", "\\|").replace("\n", "<br>")


def md_table(t):
    if t["nrows"] == 1 and t["ncols"] == 1:
        return "\n".join("> " + l if l else ">" for l in t["cells"][0]["text"].split("\n"))
    if all(c["rowspan"] == 1 and c["colspan"] == 1 for c in t["cells"]):
        grid = [[""] * t["ncols"] for _ in range(t["nrows"])]
        for c in t["cells"]:
            grid[c["row"]][c["col"]] = md_cell(c["text"])
        rows = ["| " + " | ".join(r) + " |" for r in grid]
        rows.insert(1, "|" + "---|" * t["ncols"])
        return "\n".join(rows)
    lines = ["<table>"]
    for r in range(t["nrows"]):
        lines.append("<tr>")
        for c in (c for c in t["cells"] if c["row"] == r):
            span = (f' rowspan="{c["rowspan"]}"' if c["rowspan"] > 1 else "") + \
                   (f' colspan="{c["colspan"]}"' if c["colspan"] > 1 else "")
            lines.append(f"<td{span}>{html.escape(c['text'], quote=False).replace(chr(10), '<br>')}</td>")
        lines.append("</tr>")
    lines.append("</table>")
    return "\n".join(lines)


def render_markdown(blocks, pages_info, src, sha, name):
    out = [
        "<!--",
        f"Transcript of: {src}",
        f"SHA-256:       {sha}",
        "Generated by:  tools/spec/pdf2md.py — do not edit; regenerate instead.",
        "Conventions:   see README.md next to this file.",
        "-->",
    ]
    printed = {p["page"]: p["printed"] for p in pages_info}
    page = None
    for b in blocks:
        if b["page"] != page:
            page = b["page"]
            out.append(f"\n<!-- page {page} · printed {printed.get(page) or '-'} · {name}/pages/p{page:03d}.png -->")
        if b["type"] == "heading":
            out.append("\n" + "#" * b["level"] + " " + b["text"])
        elif b["type"] == "paragraph":
            out.append("\n" + "\n".join(b["lines"]))
        elif b["type"] == "caption":
            note = f"  (figure: see {name}/pages/p{page:03d}.png)" if b["kind"] == "그림" else ""
            out.append(f"\n*{b['text']}*{note}")
        elif b["type"] == "table":
            if len(b["pages"]) > 1:
                out.append(f"\n<!-- table continues over pages {b['pages'][0]}–{b['pages'][-1]} -->")
            out.append("\n" + md_table(b))
    return "\n".join(out).lstrip("\n") + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--name", required=True, help="short output name, e.g. hwp5")
    ap.add_argument("--dpi", type=int, default=120, help="resolution of page renders")
    a = ap.parse_args()

    with open(a.pdf, "rb") as fh:
        sha = hashlib.sha256(fh.read()).hexdigest()
    chars, fixes = read_chars(a.pdf)
    rules = read_rules(a.pdf)
    body = body_size(chars)
    furniture = find_furniture(chars)
    blocks, pages_info, irregular = [], [], 0
    for n in sorted(chars):
        w, h, cs = chars[n]
        bl, info, irr = page_blocks(n, w, h, cs, rules, body, furniture)
        blocks += bl
        pages_info.append(info)
        irregular += irr
    blocks = join_continued_tables(blocks)
    attach_captions(blocks)
    for b in blocks:
        b.pop("y", None)

    os.makedirs(os.path.join(a.out, a.name, "pages"), exist_ok=True)
    with open(os.path.join(a.out, a.name + ".md"), "w", encoding="utf-8") as fh:
        fh.write(render_markdown(blocks, pages_info, os.path.relpath(a.pdf), sha, a.name))
    index = {
        "headings": [{"level": b["level"], "text": b["text"], "page": b["page"]} for b in blocks if b["type"] == "heading"],
        "tables": [{"caption": b.get("caption"), "pages": b["pages"], "nrows": b["nrows"], "ncols": b["ncols"]}
                   for b in blocks if b["type"] == "table"],
        "figures": [{"caption": b["text"], "page": b["page"]} for b in blocks if b["type"] == "caption" and b["kind"] == "그림"],
    }
    doc = {"source": {"path": os.path.relpath(a.pdf), "sha256": sha, "pages": len(chars)},
           "generator": "tools/spec/pdf2md.py", "glyph_fixes": dict(fixes),
           "pages": pages_info, "index": index, "blocks": blocks}
    with open(os.path.join(a.out, a.name + ".json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
    subprocess.run(["mutool", "draw", "-q", "-r", str(a.dpi), "-o",
                    os.path.join(a.out, a.name, "pages", "p%03d.png"), a.pdf], check=True)

    unknown = sum(t.count("\ufffd") for b in blocks for t in
                  (b.get("lines") or [b.get("text") or ""] + [c["text"] for c in b.get("cells", [])]))
    print(f"{a.name}: {len(chars)} pages, {len(index['headings'])} headings, {len(index['tables'])} tables "
          f"({sum(1 for t in index['tables'] if t['caption'])} captioned), {len(index['figures'])} figure captions, "
          f"{irregular} irregular merges, {unknown} unmapped glyphs left, fixes {dict(fixes)}", file=sys.stderr)


if __name__ == "__main__":
    main()
