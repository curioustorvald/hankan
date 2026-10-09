#!/usr/bin/env python3
# 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
#
# Measures character widths from the renders of a calibration batch made by
# tools/render/make-calibration.js. Generic image measurement; no knowledge
# of the file formats.
#
#   python3 tools/render/calibrate.py render-batches/003 [--write]
#
# For every changed blank it finds the one line that differs from the
# corpus render, and the horizontal shift of the text after the blank (the
# shift that makes it match best). From the shifts of the variants it
# derives the advance of a space, a Hangul syllable, a digit, a lower-case
# letter and a hyphen, then the font's glyph widths (advance divided out of
# the character shape's ratio, relative size and spacing). It prints a table
# and writes <batch>/calibration.json; --write also updates
# engine/src/form/metrics.js with the per-font medians.

import argparse
import json
import re
import statistics
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
DPI = 150
INK = 160          # grey level below which a pixel is ink
CHANGED = 48       # difference that counts as a change
SEARCH = 140       # largest shift tried, px

CLASS_OF = {'del2': 'space', 'han2': 'hangul', 'dig2': 'digit', 'low2': 'lower', 'hyp2': 'punct'}
LANG_OF = {'space': 'latin', 'hangul': 'hangul', 'digit': 'latin', 'lower': 'latin', 'punct': 'latin'}


def pages(directory, stem):
    found = {}
    for p in directory.glob(f'{stem}_p*.jpg'):
        m = re.fullmatch(re.escape(stem) + r'_p(\d+)', p.stem)
        if m:
            found[int(m.group(1))] = p
    return [found[k] for k in sorted(found)]


def grey(path):
    return np.asarray(Image.open(path).convert('L'), dtype=np.int16)


def bands(mask, gap=4):
    rows = np.nonzero(mask.any(axis=1))[0]
    if not len(rows):
        return []
    out, start, prev = [], rows[0], rows[0]
    for r in rows[1:]:
        if r - prev > gap:
            out.append((start, prev))
            start = r
        prev = r
    out.append((start, prev))
    return out


def measure(base_pages, var_pages, em):
    """Shift (px, sub-pixel) of the text that follows the change, or (None, reason)."""
    if len(base_pages) != len(var_pages):
        return None, f'page count {len(base_pages)} → {len(var_pages)}'
    changed = []
    for a, b in zip(base_pages, var_pages):
        ga, gb = grey(a), grey(b)
        if ga.shape != gb.shape:
            return None, 'page size differs'
        m = np.abs(ga - gb) > CHANGED
        if m.any():
            changed.append((ga, gb, m))
    if len(changed) != 1:
        return None, f'{len(changed)} pages changed'
    ga, gb, m = changed[0]
    bs = bands(m)
    if len(bs) != 1:
        return None, f'{len(bs)} lines changed'
    y0, y1 = max(0, bs[0][0] - 3), min(ga.shape[0], bs[0][1] + 4)
    x0 = int(np.nonzero(m[y0:y1].any(axis=0))[0][0])
    ink = (ga[y0:y1] < INK).any(axis=0)
    cols = np.nonzero(ink)[0]
    after = cols[cols >= x0]
    if not len(after):
        return None, 'no text after the blank'
    # The text right after the blank: ink up to the first gap wider than 0.6 em,
    # so that stationary text or borders further along the row are left out.
    xt = int(after[0])
    xe = xt
    gap = max(6, int(0.6 * em))
    for c in after[1:]:
        if c - xe > gap:
            break
        xe = int(c)
    xe += 1
    a = 255.0 - ga[y0:y1, xt:xe]
    a -= a.mean()
    na = np.sqrt((a * a).sum())
    if na == 0:
        return None, 'empty window'
    scores = {}
    for dx in range(-SEARCH, SEARCH + 1):
        lo, hi = xt + dx, xe + dx
        if lo < 0 or hi > gb.shape[1]:
            continue
        b = 255.0 - gb[y0:y1, lo:hi]
        b = b - b.mean()
        nb = np.sqrt((b * b).sum())
        scores[dx] = float((a * b).sum() / (na * nb)) if nb else -1.0
    dx = max(scores, key=scores.get)
    best = scores[dx]
    if best < 0.75:
        return None, f'no good match (correlation {best:.2f})'
    # Sub-pixel: the peak of a parabola through the best score and its neighbours.
    l, r = scores.get(dx - 1), scores.get(dx + 1)
    frac = 0.0
    if l is not None and r is not None and (l - 2 * best + r) < 0:
        frac = 0.5 * (l - r) / (l - 2 * best + r)
    return dx + frac, f'correlation {best:.3f}, window {xe - xt}px'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('batch', type=Path)
    ap.add_argument('--corpus', type=Path, default=ROOT / 'provenance' / 'Corpus')
    ap.add_argument('--write', action='store_true')
    args = ap.parse_args()
    manifest = json.loads((args.batch / 'manifest.json').read_text(encoding='utf-8'))
    files = args.batch / 'files'

    results = []
    for blank in manifest['blanks']:
        src = Path(blank['source'])
        base = pages(args.corpus / src.parent.name, src.stem)
        st = blank['style']
        em = st['size'] / 100 * DPI / 72  # px per em of the base size
        row = {'id': blank['id'], 'source': blank['source'], 'key': blank['key'], 'style': st, 'shift': {}, 'note': {}}
        for variant, stem in blank['files'].items():
            dx, note = measure(base, pages(files, stem), em)
            row['shift'][variant] = dx
            row['note'][variant] = note
        s = row['shift']
        adv = {}
        if s.get('del2') is not None:
            adv['space'] = -s['del2'] / 2 / em
            for v, cls in CLASS_OF.items():
                if v != 'del2' and s.get(v) is not None:
                    adv[cls] = s[v] / 2 / em + adv['space']
        row['advance'] = adv
        # Glyph width: advance = glyph × ratio × relSize × (1 + spacing), per
        # language (spacing scales the advance; see R6 in PROVENANCE.md).
        glyph = {}
        for cls, a in adv.items():
            lang = LANG_OF[cls]
            scale = st['ratio'][lang] / 100 * st['relSize'][lang] / 100 * (1 + st['spacing'][lang] / 100)
            glyph[cls] = a / scale
        row['glyph'] = glyph
        if s.get('fill') is not None:
            row['fillShift'] = s['fill'] / em
        results.append(row)

    print(f"{'#':>3} {'fonts':40} {'space':>6} {'hangul':>6} {'digit':>6} {'lower':>6} {'punct':>6} {'fill':>8}")
    for r in results:
        g = r['glyph']
        f = lambda k: f"{g[k]:6.3f}" if k in g else '     -'
        fe = f"{r['fillShift']:8.3f}" if 'fillShift' in r else '       -'
        print(f"{r['id']:>3} {r['key'][:40]:40} {f('space')} {f('hangul')} {f('digit')} {f('lower')} {f('punct')} {fe}")
        for v, n in r['note'].items():
            if r['shift'][v] is None:
                print(f"      {v}: {n}")

    # Robust widths. A blank whose space is far from the common value had its
    # size misread (its whole scale is off) and is left out; so is any single
    # value far from the median of its class.
    by_class = {}
    for r in results:
        for cls, w in r['glyph'].items():
            by_class.setdefault(cls, []).append(w)
    base = {cls: statistics.median(ws) for cls, ws in by_class.items()}
    kept = []
    for r in results:
        sp = r['glyph'].get('space')
        if sp is None or abs(sp / base['space'] - 1) > 0.10:
            r['excluded'] = 'scale'
            continue
        kept.append(r)
    per_class, per_face = {}, {}
    for r in kept:
        hangul_face, latin_face, space_kind = r['key'].split('|')
        for cls, w in r['glyph'].items():
            if abs(w / base[cls] - 1) <= 0.15:
                per_class.setdefault(cls, []).append(w)
            face = hangul_face if LANG_OF[cls] == 'hangul' else latin_face
            name = 'fontSpace' if cls == 'space' and space_kind == 'fontSpace' else cls
            per_face.setdefault(face, {}).setdefault(name, []).append(w)
    base = {cls: round(statistics.median(ws), 3) for cls, ws in sorted(per_class.items())}

    def face_width(ws):
        # Three or more samples: their median. Two that disagree, or one far
        # from the common width: not trusted.
        if len(ws) >= 3:
            return statistics.median(ws)
        if len(ws) == 2 and abs(ws[0] / ws[1] - 1) > 0.05:
            return None
        return statistics.median(ws)

    # Per font, only what differs from the common widths by 2% or more.
    medians = {}
    for face, d in sorted(per_face.items()):
        diff = {}
        for cls, ws in sorted(d.items()):
            w = face_width(ws)
            if w is None or (len(ws) < 3 and abs(w / base.get(cls, w) - 1) > 0.15):
                continue
            if abs(w / base.get(cls, w) - 1) >= 0.02:
                diff[cls] = round(w, 3)
        if diff:
            medians[face] = diff
    excluded = [r['id'] for r in results if r.get('excluded')]
    print(f"\ncommon widths (em), from {len(kept)} blanks; left out for a misread scale: {excluded}")
    print(json.dumps(base, ensure_ascii=False))
    print('fonts that differ:')
    fills = [r['fillShift'] for r in results if 'fillShift' in r]
    print(f"\nfill: text after the blank moved by a median {statistics.median(fills):+.3f} em over {len(fills)} blanks "
          "(the test value is wider than many blanks, so some movement is expected)" if fills else '\nno fill measured')
    print(json.dumps(medians, ensure_ascii=False, indent=1))
    (args.batch / 'calibration.json').write_text(json.dumps({'results': results, 'base': base, 'fonts': medians}, ensure_ascii=False, indent=1), encoding='utf-8')
    if args.write:
        target = ROOT / 'engine' / 'src' / 'form' / 'metrics.js'
        text = target.read_text(encoding='utf-8')
        text = re.sub(r'export const BASE = [\s\S]*?;\n', f'export const BASE = {json.dumps(base, ensure_ascii=False)};\n', text)
        text = re.sub(r'export const MEASURED = [\s\S]*?;\n', f'export const MEASURED = {json.dumps(medians, ensure_ascii=False, indent=2)};\n', text)
        target.write_text(text, encoding='utf-8')
        print(f'updated {target}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
