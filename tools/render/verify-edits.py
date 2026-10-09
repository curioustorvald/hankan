#!/usr/bin/env python3
# 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
#
# Checks the renders of an edit batch made by tools/render/make-edit-batch.js
# against the corpus renders. Generic image measurement; no knowledge of the
# file formats.
#
#   python3 tools/render/verify-edits.py render-batches/006
#
#   K  coloured text turned black, text unchanged: the pages are the same
#      size and number, every changed pixel lies on (or within 3 px of) a
#      coloured pixel of the corpus render, something changed, and the
#      changed pixels are no longer coloured
#   E  edits by hand: the page count does not change (side-by-side pages
#      for review)
#
# Writes <batch>/review/index.html.

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
CHROMA = 60        # max - min of RGB above which a pixel counts as coloured
NEAR = 3           # px around coloured ink that a change may touch (anti-aliasing)
STRAY = compare.NOISE_PIXELS


def rgb(path):
    return np.asarray(Image.open(path).convert('RGB'), dtype=np.int16)


def chroma(a):
    return a.max(axis=2) - a.min(axis=2)


def check_recolour(base, out):
    """(ok, detail) for one K file."""
    if len(base) != len(out):
        return False, f'pages {len(base)} → {len(out)}'
    changed = stray = 0
    leftover = []
    for a, c in zip(base, out):
        ra, rc = rgb(a), rgb(c)
        if ra.shape != rc.shape:
            return False, 'page size changed'
        mask = np.abs(ra.mean(axis=2) - rc.mean(axis=2)) > calibrate.CHANGED
        near = ndimage.binary_dilation(chroma(ra) > CHROMA, iterations=NEAR)
        changed += int(mask.sum())
        stray += int((mask & ~near).sum())
        if mask.any():
            leftover.append(float(chroma(rc)[mask].mean()))
    if not changed:
        return False, 'no visible change'
    still = max(leftover) if leftover else 0.0
    ok = stray <= STRAY and still < 40
    return ok, f'{changed} px changed, {stray} away from coloured ink, chroma there now {still:.0f}'


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
    sections = []

    def show(entry, status, base, out):
        images = []
        for k, (a, c) in enumerate(zip(base, out), 1):
            d = compare.diff(a, c)
            if not compare.same(d):
                name = f"{entry['file']}-p{k}.jpg"
                compare.review_image(a, c, d.get('mask'), review / name)
                images.append(name)
        imgs = ''.join(f'<img loading="lazy" src="{html.escape(i)}" alt="">' for i in images)
        sections.append(f"<section><h2>{html.escape(entry['file'])}</h2><p>{html.escape(entry['source'])} · {html.escape(status)}</p>{imgs}</section>")

    print('K: coloured text turned black')
    for k in manifest['recolour']:
        src = Path(k['source'])
        base = calibrate.pages(args.corpus / src.parent.name, src.stem)
        out = calibrate.pages(files, k['file'])
        if not out:
            print(f"  {k['file']}: no render")
            continue
        ok, detail = check_recolour(base, out)
        failures += not ok
        print(f"  {k['file']:34} {'PASS' if ok else 'FAIL'} {k['colour']} {k['text'][:16]!r:20} {detail}")
        show(k, detail, base, out)

    print('E: edits by hand (page count)')
    for e in manifest['edits']:
        src = Path(e['source'])
        base = calibrate.pages(args.corpus / src.parent.name, src.stem)
        out = calibrate.pages(files, e['file'])
        if not out:
            print(f"  {e['file']}: no render")
            continue
        ok = len(base) == len(out)
        failures += not ok
        status = f'pages {len(base)} → {len(out)}; ' + '; '.join(f"{x['from'][:20]!r} → {x['to'][:20]!r}" for x in e['edits'])
        print(f"  {e['file']:34} {'PASS' if ok else 'FAIL'} {status}")
        show(e, status, base, out)

    (review / 'index.html').write_text(
        '<!doctype html><meta charset="utf-8"><title>Edit batch review</title>'
        '<style>body{font:14px system-ui,sans-serif;margin:16px;background:#fff;color:#111}'
        'section{margin:0 0 32px}img{max-width:100%;display:block;margin:8px 0;border:1px solid #ccc}'
        'h2{font-size:15px;margin:0}</style>'
        '<p>Each image: corpus render | edited render | changes in red.</p>' + ''.join(sections), encoding='utf-8')
    print(f'\n{failures} failed; review page: {review / "index.html"}')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
