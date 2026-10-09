#!/usr/bin/env python3
"""Harvest blank application forms attached to public-institution job
postings on job.alio.go.kr (공공기관 채용정보시스템) into the corpus pool.

Postings are sampled at random across the posting-id range so that the
pool spans many institutions and several years of authoring tools. Only
attachments whose name or slot says "form" (입사지원서, 서약서, 동의서 …)
and whose bytes sniff as HWP/HWPX are kept; announcements are skipped.
"""
import argparse
import csv
import hashlib
import html
import os
import random
import re
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harvest_lawgokr import EXT, MANIFEST_FIELDS, get, safe_name, sniff  # noqa: E402

VIEW = "https://job.alio.go.kr/recruitview.do?idx={}"
DELAY = 0.8

FORM_RE = re.compile(
    r"지원서|원서|서약서|동의서|확인서|신청서|자기소개서|경력기술서|경험기술서|"
    r"계획서|서식|양식|별지|이력서|위임장|진술서|확약서|명세서|증명서|신고서|체크리스트"
)
NOT_FORM_RE = re.compile(r"공고|직무기술서|안내|요강|Q&A|FAQ|모집", re.I)
STRONG_RE = re.compile(r"서식|양식|별지|지원서|원서")

H2_RE = re.compile(r'<div class="topInfo">\s*<h2>(.*?)</h2>', re.S)
TITLE_RE = re.compile(r'<p class="titleH2" title="(.*?)"', re.S)
ROW_RE = re.compile(r"<th>(.*?)</th>\s*<td>(.*?)</td>", re.S)
LINK_RE = re.compile(r'href="(https://www\.alio\.go\.kr/download/download\.json\?fileNo=(\d+))"[^>]*>\s*(.*?)\s*</a>', re.S)


def is_form(slot, name, exts=(".hwp", ".hwpx")):
    stem, ext = os.path.splitext(name)
    if ext.lower() not in exts:
        return False
    if "공고문" in stem:
        return False
    if slot == "입사지원서":
        return True
    if NOT_FORM_RE.search(stem) and not STRONG_RE.search(stem):
        return False
    return bool(FORM_RE.search(stem))


def parse_view(page):
    inst = H2_RE.search(page)
    title = TITLE_RE.search(page)
    files = []
    for slot, body in ROW_RE.findall(page):
        slot = re.sub(r"<[^>]+>|\s+", "", slot)
        for url, fileno, name in LINK_RE.findall(body):
            files.append((slot, url, fileno, html.unescape(re.sub(r"<[^>]+>", "", name)).strip()))
    return (html.unescape(inst.group(1)).strip() if inst else "",
            html.unescape(title.group(1)).strip() if title else "", files)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pool", default="corpus-pool")
    ap.add_argument("--seed", type=int, default=20261008)
    ap.add_argument("--lo", type=int, default=120000)
    ap.add_argument("--hi", type=int, default=305870)
    ap.add_argument("--target", type=int, default=400, help="files to keep in this run")
    ap.add_argument("--max-probes", type=int, default=3000)
    ap.add_argument("--per-inst", type=int, default=2, help="postings per institution")
    ap.add_argument("--ext", default=".hwp,.hwpx", help="attachment extensions to consider")
    a = ap.parse_args()

    os.makedirs(os.path.join(a.pool, "_manifests"), exist_ok=True)
    manifest = os.path.join(a.pool, "_manifests", "job.alio.go.kr.csv")
    have_ids, have_sha, inst_posts = set(), set(), {}
    if os.path.exists(manifest):
        with open(manifest, encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                have_ids.add(row["source_id"])
                have_sha.add(row["sha256"])
    probed_path = os.path.join(a.pool, "_index", "alio-probed.txt")
    os.makedirs(os.path.dirname(probed_path), exist_ok=True)
    probed = set()
    if os.path.exists(probed_path):
        with open(probed_path) as fh:
            for line in fh:
                idx, inst = (line.rstrip("\n").split("\t") + [""])[:2]
                probed.add(int(idx))
                if inst:
                    inst_posts[inst] = inst_posts.get(inst, 0) + 1
    new = not os.path.exists(manifest)
    mf = open(manifest, "a", encoding="utf-8", newline="")
    w = csv.DictWriter(mf, MANIFEST_FIELDS)
    if new:
        w.writeheader()
    pf = open(probed_path, "a")

    rng = random.Random(a.seed)
    order = list(range(a.lo, a.hi + 1))
    rng.shuffle(order)
    kept, probes = 0, 0
    exts = tuple(e.strip().lower() for e in a.ext.split(","))
    out_dir = os.path.join(a.pool, "job.alio.go.kr")
    os.makedirs(out_dir, exist_ok=True)
    for idx in order:
        if kept >= a.target or probes >= a.max_probes:
            break
        if idx in probed:
            continue
        probes += 1
        try:
            page = get(VIEW.format(idx))
        except Exception as e:  # noqa: BLE001
            print(f"idx {idx}: {e}", file=sys.stderr)
            continue
        time.sleep(DELAY)
        inst, title, files = parse_view(page)
        forms = [f for f in files if is_form(f[0], f[3], exts) and f[2] not in have_ids]
        if not inst or not forms or inst_posts.get(inst, 0) >= a.per_inst:
            pf.write(f"{idx}\t\n")
            pf.flush()
            continue
        inst_posts[inst] = inst_posts.get(inst, 0) + 1
        pf.write(f"{idx}\t{inst}\n")
        pf.flush()
        for slot, url, fileno, name in forms[:5]:
            try:
                data, _ = get(url, binary=True)
            except Exception as e:  # noqa: BLE001
                print(f"  {url}: {e}", file=sys.stderr)
                continue
            time.sleep(DELAY)
            fmt = sniff(data)
            sha = hashlib.sha256(data).hexdigest()
            if fmt not in EXT or sha in have_sha:
                print(f"  skip {fmt}{' dup' if sha in have_sha else ''} {name}")
                continue
            have_sha.add(sha)
            have_ids.add(fileno)
            stem = os.path.splitext(name)[0]
            sub = out_dir if fmt != "hwp3" else out_dir + "-hwp3"
            os.makedirs(sub, exist_ok=True)
            rel = os.path.relpath(os.path.join(sub, f"{fileno}_{safe_name(inst, 20)}_{safe_name(stem, 50)}.{EXT[fmt]}"), a.pool)
            with open(os.path.join(a.pool, rel), "wb") as out:
                out.write(data)
            w.writerow({
                "path": rel, "format": fmt, "sha256": sha, "bytes": len(data),
                "title": stem, "parent": title, "org": inst, "date": "",
                "source": "job.alio.go.kr", "catalogue": slot, "source_id": fileno,
                "url": url, "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            })
            mf.flush()
            kept += 1
            print(f"[{kept}/{a.target}] {fmt} {rel}")
    print(f"done: kept={kept} probes={probes} institutions={len(inst_posts)}")


if __name__ == "__main__":
    main()
