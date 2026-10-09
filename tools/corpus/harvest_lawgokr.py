#!/usr/bin/env python3
"""Harvest form attachments (별지/서식) from the national law information
center's open API (law.go.kr DRF) into the corpus pool.

Three catalogues are used:
  licbyl   - forms attached to statutes / enforcement decrees / rules
  admbyl   - forms attached to administrative rules (훈령, 예규, 고시, 공고 …)
  ordinbyl - forms attached to local-government bylaws (조례, 규칙)

Phases (each re-runnable, idempotent):
  index   query the API for form-sounding keywords, store raw metadata
  select  filter to actual forms, de-duplicate, sample for diversity
  fetch   download selected files, sniff the real format, write manifest

Only the downloaded bytes are kept; this script never parses HWP content
beyond the magic number needed to decide the file extension.
"""
import argparse
import csv
import hashlib
import html
import json
import os
import random
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone

BASE = "https://www.law.go.kr"
UA = "Mozilla/5.0 (X11; Linux x86_64) corpus-harvest/0.1"
DELAY = 0.8

KEYWORDS = [
    "신청서", "신고서", "확인서", "동의서", "서약서", "위임장", "청구서",
    "지원서", "계획서", "보고서", "증명서", "추천서", "이력서", "명세서",
    "의견서", "진술서", "각서", "확약서", "의뢰서", "요청서", "결과서",
    "조사표", "점검표", "응시원서", "협약서", "계약서", "등록부", "대장",
    "통지서", "영수증", "신청 및", "변경신고", "재교부", "접수증", "허가증",
]

TARGETS = {
    # target: (record tag, org field, pages sampled per keyword, quota)
    "licbyl": ("licbyl", "소관부처명", 2, 500),
    "admbyl": ("admrulbyl", "소관부처명", 2, 350),
    "ordinbyl": ("ordinbyl", "지자체기관명", 3, 650),
}
# per-organisation cap inside one target, so one ministry / city cannot dominate
ORG_CAP = {"licbyl": 45, "admbyl": 25, "ordinbyl": 6}
FORM_KINDS = {"서식", "별지"}

TAG_RE = re.compile(r"<[^>]+>")
PREFIX_RE = re.compile(r"^\s*\[[^\]]*\]\s*")
UNSAFE_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def get(url, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
                return (data, r.headers) if binary else data.decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001 - retry anything network-ish
            if attempt == 3:
                raise
            print(f"  retry {attempt + 1} {url}: {e}", file=sys.stderr)
            time.sleep(3 * (attempt + 1))


def search(target, query, page, display=100):
    q = urllib.parse.urlencode({
        "OC": "test", "target": target, "type": "XML",
        "query": query, "display": display, "page": page,
    })
    return ET.fromstring(get(f"{BASE}/DRF/lawSearch.do?{q}"))


def clean(s):
    return html.unescape(TAG_RE.sub("", s or "")).strip()


def norm_title(t):
    return re.sub(r"\s+", "", PREFIX_RE.sub("", t))


def records(root, target):
    tag, org_field, _, _ = TARGETS[target]
    for el in root.findall(tag):
        f = {c.tag: (c.text or "") for c in el}
        yield {
            "target": target,
            "byl_id": f.get("별표일련번호", ""),
            "title": clean(f.get("별표명")),
            "parent": clean(f.get("관련법령명") or f.get("관련행정규칙명") or f.get("관련자치법규명")),
            "kind": f.get("별표종류", ""),
            "org": f.get(org_field, "") or f.get("전체기관명", ""),
            "date": f.get("공포일자") or f.get("발령일자") or "",
            "file_link": f.get("별표서식파일링크", ""),
            "pdf_link": f.get("별표서식PDF파일링크", ""),
        }


def cmd_index(pool, seed):
    rng = random.Random(seed)
    idx_dir = os.path.join(pool, "_index")
    os.makedirs(idx_dir, exist_ok=True)
    for target, (_, _, npages, _) in TARGETS.items():
        out = os.path.join(idx_dir, f"{target}.jsonl")
        done = set()
        if os.path.exists(out):
            with open(out, encoding="utf-8") as fh:
                done = {(r["_kw"], r["_page"]) for r in map(json.loads, fh)}
        with open(out, "a", encoding="utf-8") as fh:
            for kw in KEYWORDS:
                root = search(target, kw, 1, display=1)
                total = int(root.findtext("totalCnt") or 0)
                pages = max(1, (total + 99) // 100)
                picks = sorted(rng.sample(range(1, pages + 1), min(npages, pages)))
                print(f"{target} {kw!r}: total={total} pages={picks}")
                time.sleep(DELAY)
                for p in picks:
                    if (kw, p) in done:
                        continue
                    for rec in records(search(target, kw, p), target):
                        rec["_kw"], rec["_page"] = kw, p
                        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    fh.flush()
                    time.sleep(DELAY)


def cmd_select(pool, seed):
    rng = random.Random(seed)
    seen_titles = set()
    selected = []
    for target, (_, _, _, quota) in TARGETS.items():
        path = os.path.join(pool, "_index", f"{target}.jsonl")
        with open(path, encoding="utf-8") as fh:
            recs = [json.loads(line) for line in fh]
        cands, seen_ids = [], set()
        for r in recs:
            if r["kind"] not in FORM_KINDS or not r["file_link"] or r["byl_id"] in seen_ids:
                continue
            seen_ids.add(r["byl_id"])
            cands.append(r)
        rng.shuffle(cands)
        # round-robin over keywords so every keyword is represented
        by_kw = {}
        for r in cands:
            by_kw.setdefault(r["_kw"], []).append(r)
        org_count, picked = {}, []
        while len(picked) < quota and any(by_kw.values()):
            for kw in list(by_kw):
                if not by_kw[kw]:
                    continue
                r = by_kw[kw].pop()
                nt = norm_title(r["title"])
                if nt in seen_titles or org_count.get(r["org"], 0) >= ORG_CAP[target]:
                    continue
                seen_titles.add(nt)
                org_count[r["org"]] = org_count.get(r["org"], 0) + 1
                picked.append(r)
                if len(picked) >= quota:
                    break
        print(f"{target}: {len(cands)} candidates -> {len(picked)} picked, {len(org_count)} orgs")
        selected += picked
    with open(os.path.join(pool, "_index", "selected.jsonl"), "w", encoding="utf-8") as fh:
        for r in selected:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")


def sniff(data):
    if data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        return "hwp" if b"HWP Document File" in data[:1 << 20] else "cfb-other"
    if data.startswith(b"HWP Document File V3"):
        return "hwp3"
    if data[:4] == b"PK\x03\x04":
        import io
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                if "mimetype" in z.namelist() and b"hwp+zip" in z.read("mimetype"):
                    return "hwpx"
                return "zip-other"
        except zipfile.BadZipFile:
            return "zip-bad"
    if data[:5] == b"%PDF-":
        return "pdf"
    return "unknown"


EXT = {"hwp": "hwp", "hwpx": "hwpx", "hwp3": "hwp"}
MANIFEST_FIELDS = [
    "path", "format", "sha256", "bytes", "title", "parent", "org", "date",
    "source", "catalogue", "source_id", "url", "fetched_at",
]


def safe_name(s, n=70):
    s = UNSAFE_RE.sub("_", PREFIX_RE.sub("", s)).strip(" .")
    return re.sub(r"\s+", "_", s)[:n] or "untitled"


def cmd_fetch(pool, limit):
    sel = os.path.join(pool, "_index", "selected.jsonl")
    os.makedirs(os.path.join(pool, "_manifests"), exist_ok=True)
    manifest = os.path.join(pool, "_manifests", "law.go.kr.csv")
    rejects = os.path.join(pool, "_index", "rejects.jsonl")
    have_ids, have_sha = set(), set()
    if os.path.exists(manifest):
        with open(manifest, encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                have_ids.add((row["catalogue"], row["source_id"]))
                have_sha.add(row["sha256"])
    if os.path.exists(rejects):
        with open(rejects, encoding="utf-8") as fh:
            for r in map(json.loads, fh):
                have_ids.add((r["target"], r["byl_id"]))
    new_manifest = not os.path.exists(manifest)
    mf = open(manifest, "a", encoding="utf-8", newline="")
    w = csv.DictWriter(mf, MANIFEST_FIELDS)
    if new_manifest:
        w.writeheader()
    rj = open(rejects, "a", encoding="utf-8")
    with open(sel, encoding="utf-8") as fh:
        todo = [r for r in map(json.loads, fh) if (r["target"], r["byl_id"]) not in have_ids]
    if limit:
        todo = todo[:limit]
    stats = {}
    for i, r in enumerate(todo, 1):
        url = BASE + r["file_link"]
        try:
            data, _ = get(url, binary=True)
        except Exception as e:  # noqa: BLE001
            print(f"[{i}/{len(todo)}] FAIL {url}: {e}", file=sys.stderr)
            continue
        fmt = sniff(data)
        sha = hashlib.sha256(data).hexdigest()
        stats[fmt] = stats.get(fmt, 0) + 1
        if fmt not in EXT or sha in have_sha:
            rj.write(json.dumps({**r, "reason": "dup" if sha in have_sha else fmt}, ensure_ascii=False) + "\n")
            rj.flush()
            print(f"[{i}/{len(todo)}] skip {fmt}{' dup' if sha in have_sha else ''} {r['title']}")
            time.sleep(DELAY)
            continue
        have_sha.add(sha)
        flseq = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("flSeq", [r["byl_id"]])[0]
        sub = os.path.join("law.go.kr", r["target"] if fmt != "hwp3" else r["target"] + "-hwp3")
        os.makedirs(os.path.join(pool, sub), exist_ok=True)
        rel = os.path.join(sub, f"{flseq}_{safe_name(r['title'])}.{EXT[fmt]}")
        with open(os.path.join(pool, rel), "wb") as out:
            out.write(data)
        w.writerow({
            "path": rel, "format": fmt, "sha256": sha, "bytes": len(data),
            "title": r["title"], "parent": r["parent"], "org": r["org"], "date": r["date"],
            "source": "law.go.kr", "catalogue": r["target"], "source_id": r["byl_id"],
            "url": url, "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        mf.flush()
        print(f"[{i}/{len(todo)}] {fmt} {rel}")
        time.sleep(DELAY)
    print("formats seen:", stats)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("phase", choices=["index", "select", "fetch"])
    ap.add_argument("--pool", default="corpus-pool")
    ap.add_argument("--seed", type=int, default=20261008)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    if a.phase == "index":
        cmd_index(a.pool, a.seed)
    elif a.phase == "select":
        cmd_select(a.pool, a.seed)
    else:
        cmd_fetch(a.pool, a.limit)


if __name__ == "__main__":
    main()
