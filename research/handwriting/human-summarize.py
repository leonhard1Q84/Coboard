"""Summarize all human-probe results; every error counts as incorrect.

Usage: python3 human-summarize.py RAW_JSONL > SUMMARY_JSON
Single-glyph CER equals (incorrect + inference failures) / total. Case-sensitive
results are primary; case-folded results are separate diagnostics, not substitutes.
"""
import collections
import gzip
import hashlib
import json
import math
from pathlib import Path
import sys

source = Path(sys.argv[1])
raw = gzip.decompress(source.read_bytes()) if source.suffix == ".gz" else source.read_bytes()
rows = [json.loads(line) for line in raw.splitlines()]
samples = [r for r in rows if r["kind"] in {"glyph", "error"}]
if not samples or len({r["name"] for r in samples}) != len(samples):
    raise ValueError("Missing samples or duplicate IDs")

def group_summary(group):
    n = len(group)
    result = {"samples": n, "errors": sum(r["kind"] == "error" for r in group)}
    for top in [1, 5, 10]:
        result[f"top{top}_correct"] = sum(any(c["text"] == r["expected"] for c in r.get("candidates", [])[:top]) for r in group)
        result[f"top{top}_accuracy"] = result[f"top{top}_correct"] / n
    result["character_error_rate"] = 1 - result["top1_accuracy"]
    result["casefold_top1_correct"] = sum(bool(r.get("candidates")) and r["candidates"][0]["text"].casefold() == r["expected"].casefold() for r in group)
    times = sorted(r["elapsed_ms"] for r in group)
    result["compute_p50_ms"] = times[math.ceil(n * .5) - 1]
    result["compute_p95_ms"] = times[math.ceil(n * .95) - 1]
    return result

groups = {"digit": [], "uppercase": [], "lowercase": []}
writers = collections.defaultdict(list)
confusions = collections.Counter()
for r in samples:
    label = r["expected"]
    groups["digit" if label.isdigit() else "uppercase" if label.isupper() else "lowercase"].append(r)
    writers[r["writer"]].append(r)
    actual = r.get("candidates", [{}])[0].get("text", "<ERROR>")
    if actual != label:
        confusions[(label, actual)] += 1
summary = {
    "uncompressed_jsonl_sha256": hashlib.sha256(raw).hexdigest(),
    "scope": "Original isolated human strokes, deployed mixed character range; no segmentation, LM, IPC or UI; no claim that proprietary model training excluded UJI",
    "load": rows[0],
    "overall": group_summary(samples),
    "by_category": {k: group_summary(v) for k, v in groups.items() if v},
    "by_writer": {k: group_summary(v) for k, v in sorted(writers.items())},
    "confusions": [{"expected": k[0], "actual": k[1], "count": v} for k, v in confusions.most_common()],
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
