"""Summarize local probe JSONL; timings exclude trial zero and stdout encoding."""

import collections
import gzip
import hashlib
import json
import math
import sys
from pathlib import Path


def percentile(values, quantile):
    ordered = sorted(values)
    return ordered[math.ceil(len(ordered) * quantile) - 1]


def distance(a, b):
    row = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        next_row = [i]
        for j, cb in enumerate(b, 1):
            next_row.append(min(next_row[-1] + 1, row[j] + 1, row[j - 1] + (ca != cb)))
        row = next_row
    return row[-1]


source = Path(sys.argv[1])
data = gzip.decompress(source.read_bytes()) if source.suffix == ".gz" else source.read_bytes()
rows = [json.loads(line) for line in data.splitlines()]
hot = [r for r in rows if r["kind"] == "incremental" and r["trial"] > 0]
groups = collections.defaultdict(list)
for row in hot:
    groups[row["fixture"]].append(row)
summary = {
    "uncompressed_jsonl_sha256": hashlib.sha256(data).hexdigest(),
    "load": next(r for r in rows if r["kind"] == "load"),
    "hot_updates": len(hot),
    "decode_errors": sum(r["kind"] == "decode_error" for r in rows),
    "single_character_occurrences": {},
    "fixtures": [],
}
for kind, field in [("single_raw", "label"), ("single_resampled", "text")]:
    singles = [r for r in rows if r["kind"] == kind]
    summary["single_character_occurrences"][kind] = {
        "count": len(singles),
        "top1_correct": sum(r["candidates"][0][field] == r["expected"] for r in singles),
        "top10_correct": sum(any(c[field] == r["expected"] for c in r["candidates"]) for r in singles),
    }
for name, group in groups.items():
    times = [r["output"]["elapsed_ms"] for r in group]
    finals = [r for r in group if r["final"]]
    first = finals[0]
    actual = first["output"]["candidates"][0]["text"]
    summary["fixtures"].append({
        "name": name,
        "expected": first["expected"],
        "observed_top1": sorted({r["output"]["candidates"][0]["text"] for r in finals}),
        "exact_correct_trials": sum(r["output"]["candidates"][0]["text"] == r["expected"] for r in finals),
        "trials": len(finals),
        "final_top5_contains_expected": any(c["text"] == first["expected"] for c in first["output"]["candidates"]),
        "character_edits_with_spaces": distance(actual, first["expected"]),
        "character_edits_without_spaces": distance(actual.replace(" ", ""), first["expected"].replace(" ", "")),
        "updates": len(group),
        "p50_ms": percentile(times, 0.5),
        "p95_ms": percentile(times, 0.95),
        "max_ms": max(times),
        "classifier_calls": sum(r["output"]["classifier_calls"] for r in group),
        "cache_hits": sum(r["output"]["cache_hits"] for r in group),
        "max_cache_entries": max(r["output"]["cache_entries"] for r in group),
    })
print(json.dumps(summary, ensure_ascii=False, indent=2))
