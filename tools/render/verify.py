#!/usr/bin/env python3
# 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
#
# Checks the renders of a verification batch made by
# tools/render/make-verification.js against the corpus renders. Generic image
# measurement; no knowledge of the file formats.
#
#   python3 tools/render/verify.py render-batches/004
#
#   A  the text after a filled blank stays in place: |shift| < half a space
#   B  the page count does not change (and side-by-side pages for review)
#   C, F  each changed line holds a mark and the text after it does not move
#      (more than a pixel); a mark that is not exactly as wide as what it
#      replaced may redraw the rest of its line a fraction of a pixel over
#
# Writes <batch>/review/index.html for parts B and C.

import argparse
import html
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
import calibrate  # noqa: E402
import compare  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
BOX_PX = 42  # a box mark at up to about 14 pt, 150 dpi


def shift_after(ga, gc, y0, y1, x0):
    """Shift (px) of the ink right of x0 between the two renders of a line, or None."""
    ink = np.nonzero((ga[y0:y1] < calibrate.INK).any(axis=0))[0]
    after = ink[ink > x0 + 30]
    if not len(after):
        return None
    xt, xe = int(after[0]), int(after[-1]) + 1
    a = 255.0 - ga[y0:y1, xt:xe]
    a -= a.mean()
    best, score = None, -2.0
    for dx in range(-40, 41):
        if xt + dx < 0 or xe + dx > gc.shape[1]:
            continue
        b = 255.0 - gc[y0:y1, xt + dx:xe + dx]
        b -= b.mean()
        den = np.sqrt((a * a).sum() * (b * b).sum())
        sc = float((a * b).sum() / den) if den else -1.0
        if sc > score:
            best, score = dx, sc
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('batch', type=Path)
    ap.add_argument('--corpus', type=Path, default=ROOT / 'provenance' / 'Corpus')
    args = ap.parse_args()
    manifest = json.loads((args.batch / 'manifest.json').read_text(encoding='utf-8'))
    files = args.batch / 'files'
    review = args.batch / 'review'
    review.mkdir(exist_ok=True)
    failures = 0

    print('A: text after a filled blank (shift in em; must be under 0.25)')
    for b in manifest['blanks']:
        src = Path(b['source'])
        base = calibrate.pages(args.corpus / src.parent.name, src.stem)
        em = b['style']['size'] / 100 * calibrate.DPI / 72
        dx, note = calibrate.measure(base, calibrate.pages(files, b['files']['fill']), em)
        if dx is None:
            status, failures = f'n/a ({note})', failures
        else:
            shift = dx / em
            ok = abs(shift) < 0.25
            failures += not ok
            status = f"{'PASS' if ok else 'FAIL'} {shift:+.3f} em"
        print(f"  A{b['id']:02d} {b['key'][:28]:28} {b['value']:16} {status}")

    sections = []
    for f in manifest['forms']:
        src = Path(f['source'])
        base = calibrate.pages(args.corpus / src.parent.name, src.stem)
        if not base and f['source'] in manifest.get('baselines', {}):
            base = calibrate.pages(files, manifest['baselines'][f['source']])  # an unfilled re-saved copy (R0)
        out = calibrate.pages(files, f['file'])
        if not out:
            print(f"  {f['file']}: no render")
            continue
        images = []
        if f['part'] == 'B':
            ok = len(out) == len(base)
            status = f"pages {len(base)} → {len(out)}"
        else:
            lines, moved, tall = 0, [], []
            for a, c in zip(base, out):
                ga, gc = calibrate.grey(a), calibrate.grey(c)
                if ga.shape != gc.shape:
                    moved.append('page size')
                    continue
                m = np.abs(ga - gc) > calibrate.CHANGED
                for y0, y1 in calibrate.bands(m):
                    if y1 - y0 > BOX_PX:
                        tall.append(f'{y1 - y0}px')
                    y0, y1 = max(0, y0 - 3), y1 + 4
                    lines += 1
                    x0 = int(np.nonzero(m[y0:y1].any(axis=0))[0][0])
                    dx = shift_after(ga, gc, y0, y1, x0)
                    if dx is not None and abs(dx) > 1:
                        moved.append(f'{dx:+d}px')
            ok = len(out) == len(base) and not moved and not tall and 0 < lines <= f['expect']['boxesOnly']
            status = f"{lines} changed lines for {f['expect']['boxesOnly']} choices" + (f", text moved {moved[:4]}" if moved else '') + (f", taller changes {tall[:4]}" if tall else '')
        failures += not ok
        print(f"  {f['part']} {f['file']}: {'PASS' if ok else 'FAIL'} {status}")
        for k, (a, c) in enumerate(zip(base, out), 1):
            d = compare.diff(a, c)
            if not compare.same(d):
                name = f"{f['file']}-p{k}.jpg"
                compare.review_image(a, c, d.get('mask'), review / name)
                images.append(name)
        imgs = ''.join(f'<img loading="lazy" src="{html.escape(i)}" alt="">' for i in images)
        sections.append(f"<section><h2>{html.escape(f['file'])}</h2><p>{html.escape(f['source'])} · {html.escape(status)}</p>{imgs}</section>")

    (review / 'index.html').write_text(
        '<!doctype html><meta charset="utf-8"><title>Verification review</title>'
        '<style>body{font:14px system-ui,sans-serif;margin:16px;background:#fff;color:#111}'
        'section{margin:0 0 32px}img{max-width:100%;display:block;margin:8px 0;border:1px solid #ccc}'
        'h2{font-size:15px;margin:0}</style>'
        '<p>Each image: corpus render | filled render | changes in red.</p>' + ''.join(sections), encoding='utf-8')
    print(f'\n{failures} failed; review page: {review / "index.html"}')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
