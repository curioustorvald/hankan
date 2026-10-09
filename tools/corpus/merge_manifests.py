#!/usr/bin/env python3
"""Merge the per-source manifests under <pool>/_manifests/ into
<pool>/manifest.csv, drop rows whose file has gone missing (e.g. removed
during manual inspection), and report byte-identical files that were
collected from more than one source."""
import argparse
import collections
import csv
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harvest_lawgokr import MANIFEST_FIELDS  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pool", default="corpus-pool")
    a = ap.parse_args()

    rows, missing = [], 0
    for path in sorted(glob.glob(os.path.join(a.pool, "_manifests", "*.csv"))):
        with open(path, encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                if os.path.exists(os.path.join(a.pool, row["path"])):
                    rows.append(row)
                else:
                    missing += 1
    by_sha = collections.defaultdict(list)
    for r in rows:
        by_sha[r["sha256"]].append(r["path"])
    dups = {k: v for k, v in by_sha.items() if len(v) > 1}

    with open(os.path.join(a.pool, "manifest.csv"), "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, MANIFEST_FIELDS)
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: r["path"]))

    print(f"{len(rows)} files, {missing} manifest rows without a file")
    for k, v in collections.Counter((r["source"], r["format"]) for r in rows).most_common():
        print(f"  {k[0]:<16} {k[1]:<5} {v}")
    print(f"total bytes: {sum(int(r['bytes']) for r in rows):,}")
    if dups:
        print(f"{len(dups)} cross-source duplicate groups:")
        for paths in dups.values():
            print("  " + "  ==  ".join(paths))


if __name__ == "__main__":
    main()
