#!/usr/bin/env python3
"""Harvest the court forms collection (대법원 전자민원센터 양식모음,
www.scourt.go.kr/nm/minwon/doc/DocListAction.work) into the corpus pool.

Every listed attachment that sniffs as HWP/HWPX is kept; PDFs and
spreadsheets are skipped. The listing page is served in CP949.
"""
import argparse
import csv
import hashlib
import html
import os
import re
import sys
import time
import urllib.parse
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harvest_lawgokr import EXT, MANIFEST_FIELDS, get, safe_name, sniff  # noqa: E402

LIST = "https://www.scourt.go.kr/nm/minwon/doc/DocListAction.work?pageIndex={}"
FILE = "https://file.scourt.go.kr/AttachDownload?path=004&file={}&downFile={}&seqnum="
DELAY = 0.8

ROW_RE = re.compile(r'<tr>\s*<td class="taL">\s*(\d+)\s*</td>\s*<td class="taL">(.*?)</td>\s*<td>(.*?)</td>', re.S)
DOC_RE = re.compile(r"downdoc\('([^']+)','([^']*)'\)")
LAST_RE = re.compile(r'pageIndex=(\d+)"[^>]*title="마지막 페이지"')


def fetch_list(n):
    data, _ = get(LIST.format(n), binary=True)
    return data.decode("cp949", "replace")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pool", default="corpus-pool")
    a = ap.parse_args()

    os.makedirs(os.path.join(a.pool, "_manifests"), exist_ok=True)
    manifest = os.path.join(a.pool, "_manifests", "scourt.go.kr.csv")
    have_ids, have_sha = set(), set()
    if os.path.exists(manifest):
        with open(manifest, encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                have_ids.add(row["source_id"])
                have_sha.add(row["sha256"])
    new = not os.path.exists(manifest)
    mf = open(manifest, "a", encoding="utf-8", newline="")
    w = csv.DictWriter(mf, MANIFEST_FIELDS)
    if new:
        w.writeheader()

    first = fetch_list(1)
    m = LAST_RE.search(first)
    last = int(m.group(1)) if m else 1
    print(f"pages: {last}")
    out_dir = os.path.join(a.pool, "scourt.go.kr")
    os.makedirs(out_dir, exist_ok=True)
    kept = len(have_ids)
    for n in range(1, last + 1):
        page = first if n == 1 else fetch_list(n)
        time.sleep(DELAY)
        for no, title, cell in ROW_RE.findall(page):
            title = html.unescape(re.sub(r"<[^>]+>|\s+", " ", title)).strip()
            for server_name, shown in DOC_RE.findall(cell):
                if os.path.splitext(server_name)[1].lower() not in (".hwp", ".hwpx"):
                    continue
                if server_name in have_ids:
                    continue
                url = FILE.format(urllib.parse.quote(server_name), urllib.parse.quote(server_name))
                try:
                    data, _ = get(url, binary=True)
                except Exception as e:  # noqa: BLE001
                    print(f"  {url}: {e}", file=sys.stderr)
                    continue
                time.sleep(DELAY)
                fmt = sniff(data)
                sha = hashlib.sha256(data).hexdigest()
                have_ids.add(server_name)
                if fmt not in EXT or sha in have_sha:
                    print(f"  skip {fmt}{' dup' if sha in have_sha else ''} {title}")
                    continue
                have_sha.add(sha)
                sub = out_dir if fmt != "hwp3" else out_dir + "-hwp3"
                os.makedirs(sub, exist_ok=True)
                stem = os.path.splitext(server_name)[0]
                rel = os.path.relpath(os.path.join(sub, f"{stem}_{safe_name(title)}.{EXT[fmt]}"), a.pool)
                with open(os.path.join(a.pool, rel), "wb") as out:
                    out.write(data)
                w.writerow({
                    "path": rel, "format": fmt, "sha256": sha, "bytes": len(data),
                    "title": title, "parent": os.path.splitext(shown)[0], "org": "대법원",
                    "date": "", "source": "scourt.go.kr", "catalogue": "양식모음",
                    "source_id": server_name, "url": url,
                    "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                })
                mf.flush()
                kept += 1
                print(f"[p{n}/{last} #{kept}] {fmt} {rel}")
    print(f"done: kept={kept}")


if __name__ == "__main__":
    main()
