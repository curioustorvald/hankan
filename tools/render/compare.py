#!/usr/bin/env python3
# 본 제품은 한글과컴퓨터의 ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
#
# Compares the renders of a batch made by tools/render/make-batch.js with the
# renders of the corpus forms it was made from. Generic image comparison; no
# knowledge of the file formats.
#
#   python3 tools/render/compare.py render-batches/001 [--corpus-jpeg DIR]
#
# JPEG names are matched by file stem: "<stem>.jpeg" is page 1, and a page
# number may follow the stem ("<stem>_p001.jpg" as the Windows renderer
# writes them, "<stem>_2.jpg", "<stem>-p2.jpeg", "<stem> (2).jpg", or
# "<stem>/2.jpeg"). Batch renders are looked for anywhere in the batch
# directory, source renders under --corpus-jpeg (default provenance/Corpus).
#
# When a source form has no render (the corpus renders are incomplete), the
# render of its `resave` variant stands in for it: a resave holds the same
# content, and is checked against the source wherever both renders exist.
#
# Output: a summary on stdout and <batch>/review/index.html with, for every
# filled file, its pages next to the source pages and a map of the changes.

import argparse
import html
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
JPEG = re.compile(r'\.jpe?g$', re.I)
# Renders of identical input may still differ by JPEG noise if the renderer is
# not deterministic; anything above these limits is a real difference.
SAME_MEAN = 0.5   # mean absolute difference, 0–255
NOISE_PIXELS = 25 # pixels differing by more than CHANGED that still count as the same page
CHANGED = 48


def index_jpegs(root):
    """stem -> {page: path} for every JPEG below root."""
    found = {}
    for p in root.rglob('*'):
        if not p.is_file() or not JPEG.search(p.name):
            continue
        rel = p.relative_to(root)
        if 'review' in rel.parts:
            continue
        explicit = re.fullmatch(r'(.+)_p(\d+)', p.stem)
        if explicit:
            stem, page = explicit.group(1), int(explicit.group(2))
        elif len(rel.parts) > 1 and re.fullmatch(r'\d+', p.stem):
            stem, page = rel.parts[-2], int(p.stem)            # <stem>/<n>.jpeg
        else:
            m = re.fullmatch(r'(.+?)(?:[ _-]+(?:p|page|pg)?\(?(\d+)\)?)?', p.stem, re.I)
            stem, page = m.group(1), int(m.group(2) or 1)
        found.setdefault(stem, {})[page] = p
    return found


def pages_for(index, stem):
    pages = index.get(stem)
    if not pages:
        return []
    return [pages[k] for k in sorted(pages)]


def load(path):
    return np.asarray(Image.open(path).convert('L'), dtype=np.int16)


def diff(a_path, b_path):
    a, b = load(a_path), load(b_path)
    if a.shape != b.shape:
        return {'size': [a.shape, b.shape], 'mean': None, 'changed': None, 'box': None}
    d = np.abs(a - b)
    mask = d > CHANGED
    box = None
    if mask.any():
        ys, xs = np.nonzero(mask)
        box = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
    return {'size': None, 'mean': float(d.mean()), 'changed': int(mask.sum()), 'box': box, 'mask': mask}


def red_pixels(path):
    """Pixels of clearly red ink (the guide-text colour of click-here fields)."""
    a = np.asarray(Image.open(path).convert('RGB'), dtype=np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return int(((r > 160) & (g < 110) & (b < 110)).sum())


RED_TOLERANCE = 40


def check_expectations(entry, out_pages, batch_index, all_index, corpus_index, resave_pages):
    """Results of the `expect` entries of a manifest file: list of (name, ok, detail)."""
    exp = entry.get('expect') or {}
    results = []
    if exp.get('sameAs'):
        other = pages_for(all_index, exp['sameAs'])
        if not other:
            results.append(('sameAs', None, f"no render of {exp['sameAs']}"))
        else:
            ok = len(other) == len(out_pages) and all(same(diff(a, b)) for a, b in zip(other, out_pages))
            results.append(('sameAs', ok, f"{exp['sameAs']} ({len(other)} vs {len(out_pages)} pages)"))
    if exp.get('sameAsSource'):
        src = pages_for(corpus_index, Path(entry['source']).stem)
        label = 'source render'
        if not src:
            src = [p for stem, pages in all_index.items() if stem.endswith('-resave') and stem.split('-', 2)[0] == 'b001'
                   and stem.split('-')[3] == Path(entry['source']).stem for p in [pages[k] for k in sorted(pages)]]
            label = 'batch-001 resave render'
        if not src:
            results.append(('sameAsSource', None, 'no render to compare with'))
        else:
            ok = len(src) == len(out_pages) and all(same(diff(a, b)) for a, b in zip(src, out_pages))
            results.append(('sameAsSource', ok, label))
    if exp.get('noNewRed'):
        if not resave_pages:
            results.append(('noNewRed', None, 'no resave render in this batch'))
        else:
            extra = sum(map(red_pixels, out_pages)) - sum(map(red_pixels, resave_pages))
            results.append(('noNewRed', extra <= RED_TOLERANCE, f'{extra} more red pixels than the unfilled form'))
    return results


def same(page):
    return page['size'] is None and page['mean'] <= SAME_MEAN and page['changed'] <= NOISE_PIXELS


def review_image(src, out, mask, dest):
    """Source | output | changes (red), side by side, scaled down."""
    a = Image.open(src).convert('RGB')
    b = Image.open(out).convert('RGB')
    h = max(a.height, b.height)
    c = b.copy()
    if mask is not None:
        red = Image.new('RGB', c.size, (230, 30, 30))
        c = Image.composite(red, Image.blend(c, Image.new('RGB', c.size, 'white'), 0.6), Image.fromarray((mask * 255).astype('uint8')))
    sheet = Image.new('RGB', (a.width + b.width + c.width + 20, h), 'white')
    sheet.paste(a, (0, 0))
    sheet.paste(b, (a.width + 10, 0))
    sheet.paste(c, (a.width + b.width + 20, 0))
    sheet.thumbnail((2400, 1200))
    sheet.save(dest, quality=85)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('batch', type=Path)
    ap.add_argument('--corpus-jpeg', type=Path, default=ROOT / 'provenance' / 'Corpus')
    args = ap.parse_args()

    manifest = json.loads((args.batch / 'manifest.json').read_text(encoding='utf-8'))
    batch_index = index_jpegs(args.batch)
    corpus_index = index_jpegs(args.corpus_jpeg)
    review = args.batch / 'review'
    review.mkdir(exist_ok=True)

    all_index = index_jpegs(args.batch.parent)
    # A file identical to one of an earlier batch is rendered there (`renderOf`).
    stem_of = lambda e: e.get('renderOf') or Path(e['file']).stem
    index_of = lambda e: all_index if e.get('renderOf') else batch_index
    resave_entry = {e['source']: e for e in manifest['files'] if e['variant'] == 'resave'}
    rows = []
    for entry in manifest['files']:
        stem = Path(entry['file']).stem
        src_stem = Path(entry['source']).stem
        out_pages = pages_for(index_of(entry), stem_of(entry))
        src_pages = pages_for(corpus_index, src_stem)
        baseline = 'source'
        if not src_pages and entry['variant'] != 'resave' and entry['source'] in resave_entry:
            r = resave_entry[entry['source']]
            src_pages = pages_for(index_of(r), stem_of(r))
            baseline = 'resave'
        row = {'file': entry['file'], 'variant': entry['variant'], 'source': entry['source'], 'baseline': baseline,
               'pages': len(out_pages), 'source_pages': len(src_pages), 'images': [], 'status': ''}
        if not out_pages or not src_pages:
            row['status'] = 'missing ' + ('render' if not out_pages else 'source render')
            if out_pages:
                # Expectations can still be checked against other renders.
                r = resave_entry.get(entry['source'])
                resave_pages = pages_for(index_of(r), stem_of(r)) if r else []
                row['expect'] = check_expectations(entry, out_pages, batch_index, all_index, corpus_index, resave_pages)
                for name, ok, detail in row['expect']:
                    row['status'] += f"; expect {name}: {'PASS' if ok else 'FAIL' if ok is False else 'n/a'} ({detail})"
            rows.append(row)
            continue
        results = []
        for k, (s, o) in enumerate(zip(src_pages, out_pages), 1):
            d = diff(s, o)
            results.append(d)
            if entry['variant'] != 'resave' or not same(d):
                img = f'{stem}-p{k}.jpg'
                review_image(s, o, d.get('mask'), review / img)
                row['images'].append(img)
        if entry['variant'] == 'resave':
            ok = len(out_pages) == len(src_pages) and all(same(d) for d in results)
            row['status'] = 'PASS identical' if ok else 'FAIL differs from source'
        else:
            changed = sum(1 for d in results if not same(d))
            row['status'] = f'{changed} of {len(results)} pages changed' + (' (vs resave)' if baseline == 'resave' else '')
            if len(out_pages) != len(src_pages):
                row['status'] += f'; page count {len(src_pages)} → {len(out_pages)}'
        row['diffs'] = [{k: v for k, v in d.items() if k != 'mask'} for d in results]
        r = resave_entry.get(entry['source'])
        resave_pages = pages_for(index_of(r), stem_of(r)) if r else []
        row['expect'] = check_expectations(entry, out_pages, batch_index, all_index, corpus_index, resave_pages)
        for name, ok, detail in row['expect']:
            row['status'] += f"; expect {name}: {'PASS' if ok else 'FAIL' if ok is False else 'n/a'} ({detail})"
        rows.append(row)

    width = max(len(r['file']) for r in rows)
    for r in rows:
        print(f"{r['file']:<{width}}  {r['status']}")
    resave = [r for r in rows if r['variant'] == 'resave']
    print(f"\nresave: {sum(r['status'].startswith('PASS') for r in resave)} of {len(resave)} identical to their source")
    checks = [ok for r in rows for _, ok, _ in r.get('expect', [])]
    if checks:
        print(f"expectations: {checks.count(True)} passed, {checks.count(False)} failed, {checks.count(None)} not checkable")

    items = []
    for r in rows:
        imgs = ''.join(f'<img loading="lazy" src="{html.escape(i)}" alt="">' for i in r['images'])
        items.append(f'<section><h2>{html.escape(r["file"])}</h2><p>{html.escape(r["source"])} · {html.escape(r["status"])}</p>{imgs}</section>')
    (review / 'index.html').write_text(
        '<!doctype html><meta charset="utf-8"><title>Render review</title>'
        '<style>body{font:14px system-ui,sans-serif;margin:16px;background:#fff;color:#111}'
        'section{margin:0 0 32px}img{max-width:100%;display:block;margin:8px 0;border:1px solid #ccc}'
        'h2{font-size:15px;margin:0}</style>'
        '<p>Each image: source render | filled render | changes in red.</p>' + ''.join(items),
        encoding='utf-8')
    (review / 'results.json').write_text(json.dumps(rows, ensure_ascii=False, indent=1, default=str), encoding='utf-8')
    print(f'review page: {review / "index.html"}')
    failed = any(r['status'].startswith('FAIL') or any(ok is False for _, ok, _ in r.get('expect', [])) for r in rows)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
