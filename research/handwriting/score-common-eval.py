"""Score complete inventories, never drop failures or pool diagnostic/development data.

python3 score-common-eval.py SAMPLES_JSON RESULTS_JSONL [--check] > SUMMARY_JSON
--check exits 1 when provisional acceptance requirements or coverage are unmet.
Truncated output, missing samples, duplicate finals and unknown IDs always fail.
"""
import collections
import gzip
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent


def distance(a, b):
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        previous, row = row, [i]
        for j, y in enumerate(b, 1):
            row.append(min(row[-1] + 1, previous[j] + 1, previous[j - 1] + (x != y)))
    return row[-1]


def score(samples, rows, targets):
    inventory = {s["name"]: s for s in samples}
    if not inventory or len(inventory) != len(samples):
        raise ValueError("Empty inventory or duplicate sample IDs")
    finals, steps = {}, []
    for row in rows:
        if row["kind"] == "prepare":
            continue
        if row["kind"] not in {"result", "error"} or row["name"] not in inventory:
            raise ValueError("Unexpected result kind or sample ID")
        steps.append(row)
        if row["final"]:
            if row["name"] in finals:
                raise ValueError("Duplicate final result")
            finals[row["name"]] = row
    if set(finals) != set(inventory):
        raise ValueError("Incomplete run: missing final results")
    for name, row in finals.items():
        observed_steps = [r["end"] for r in steps if r["name"] == name]
        expected_steps = list(range(1, row["end"] + 1)) if inventory[name].get("incremental") else [len(inventory[name]["strokes"])]
        if observed_steps != expected_steps:
            raise ValueError("Missing, duplicated or out-of-order pen-up results")
        if row["kind"] == "result" and row["end"] != len(inventory[name]["strokes"]):
            raise ValueError("Premature success marked as final")
    groups = collections.defaultdict(list)
    failures = []
    for name, sample in inventory.items():
        row = finals[name]
        groups[sample["role"], sample["group"]].append((sample, row))
        candidates = [c["text"] for c in row.get("candidates", [])]
        correct = (not candidates if sample["group"] == "negative" else
                   bool(candidates) and candidates[0] == sample["expected"])
        if row["kind"] == "error" or not correct:
            failures.append({"name": name, "role": sample["role"], "group": sample["group"],
                             "expected": sample["expected"], "candidates": candidates,
                             "error": row.get("error")})

    def metrics(pairs):
        n = len(pairs)
        times = sorted(r["elapsed_ms"] for _, r in pairs)
        expected_chars = sum(len(s["expected"]) for s, _ in pairs)
        out = {"samples": n, "writers": len({s["writer"] for s, _ in pairs}),
               "errors": sum(r["kind"] == "error" for _, r in pairs)}
        for k in [1, 5]:
            correct = sum((not r.get("candidates") if s["group"] == "negative" else
                           s["expected"] in [c["text"] for c in r.get("candidates", [])[:k]])
                          and r["kind"] == "result" for s, r in pairs)
            out[f"top{k}_correct"] = correct
            out[f"top{k}_accuracy"] = correct / n
        out["cer"] = sum(distance(s["expected"], (r.get("candidates") or [{"text": ""}])[0]["text"])
                         for s, r in pairs) / expected_chars if expected_chars else None
        # All outcomes, including errors, stay in timing and accuracy denominators.
        out["compute_p50_ms"] = times[math.ceil(n * .5) - 1]
        out["compute_p95_ms"] = times[math.ceil(n * .95) - 1]
        out["compute_max_ms"] = times[-1]
        out["cross_script_top1"] = sum(s["group"] == "english-word" and any(
            "\u3400" <= c <= "\u9fff" for c in (r.get("candidates") or [{"text": ""}])[0]["text"])
            for s, r in pairs)
        return out

    coverage = {}
    for group, words in targets.items():
        if group in {"version", "note"}:
            continue
        words = list(words)
        available = [s for s in samples if s["group"] == group]
        missing = [t for t in words if not any(s["target"] == t for s in available)]
        # Neither composed ink nor known development regressions count as unseen
        # naturally written words/Chinese. At least 20 independent writers/target.
        allowed = {"human-natural", "human-isolated"} if group in {
            "digit", "uppercase", "lowercase", "chinese-character"} else {"human-natural"}
        natural_missing = [t for t in words if len({s["writer"] for s in available
                           if s["target"] == t and s["role"] in allowed}) < 20]
        coverage[group] = {"targets": len(words), "any_ink_missing": missing,
                           "acceptance_missing_20_natural_writers": natural_missing}
    invariants = {
        "retry_failures": sum(r.get("retry_equal") is False for r in steps),
        "stroke_identity_failures": sum(r.get("ids_equal") is False for r in steps),
        "wrong_stable_prefix_steps": sum(bool(r.get("stable_text")) and
            not inventory[r["name"]]["expected"].startswith(r["stable_text"]) for r in steps),
    }
    group_metrics = {f"{role}/{group}": metrics(pairs) for (role, group), pairs in sorted(groups.items())}
    offline_failures = []
    for group, cov in coverage.items():
        if cov["acceptance_missing_20_natural_writers"]:
            offline_failures.append(f"{group}: missing independent natural ink")
        allowed = {"human-natural", "human-isolated"} if group in {
            "digit", "uppercase", "lowercase", "chinese-character"} else {"human-natural"}
        independent = [(s, finals[s["name"]]) for s in samples if s["group"] == group and s["role"] in allowed]
        natural = metrics(independent) if independent else None
        top1, top5 = (.90, .98) if group == "mixed-line" else (.95, .99)
        if natural and (natural["top1_accuracy"] < top1 or natural["top5_accuracy"] < top5
                        or natural["compute_p95_ms"] > 200 or natural["errors"]):
            offline_failures.append(f"{group}: accuracy/latency/error gate failed")
        if group == "negative" and natural and natural["top1_accuracy"] < .99:
            offline_failures.append("negative: false candidate offers exceed 1%")
    if any(invariants.values()):
        offline_failures.append("retry, identity or stable-prefix invariant failed")
    acceptance = {"passed": False, "offline_passed": not offline_failures,
                  "offline_failures": offline_failures,
                  "status": "blocked: natural-ink coverage/quality or separate UI acceptance pending",
                  "provisional_requirements": "20 natural writers per target; Top1>=95%, Top5>=99% per language group (mixed>=90%/98%); compute p95<=200ms; UI p95<=300ms separately; no identity/retry failures; negative false offers<=1%",
                  "ui_measured": False}
    return {"scope": "Separate denominators for real isolated glyphs, artificially composed words, and known development ink. No natural cursive/Chinese accuracy claim.",
            "acceptance": acceptance, "samples": len(samples), "requests": len(steps),
            "by_role_and_group": group_metrics,
            "by_target": {f"{role}/{group}/{target}": metrics([(s, r) for s, r in pairs if s["target"] == target])
                          for (role, group), pairs in sorted(groups.items()) for target in sorted({s["target"] for s, _ in pairs})},
            "coverage": coverage, "invariants": invariants, "failures": failures}


if __name__ == "__main__":
    source, observed = map(Path, sys.argv[1:3])
    targets_path = ROOT / "common-targets.json"
    raw = gzip.decompress(observed.read_bytes()) if observed.suffix == ".gz" else observed.read_bytes()
    result = score(json.loads(source.read_text()), [json.loads(line) for line in raw.splitlines()],
                   json.loads(targets_path.read_text()))
    result["sha256"] = {"samples": hashlib.sha256(source.read_bytes()).hexdigest(),
                        "results_uncompressed": hashlib.sha256(raw).hexdigest(),
                        "targets": hashlib.sha256(targets_path.read_bytes()).hexdigest()}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if "--check" in sys.argv and not result["acceptance"]["passed"]:
        sys.exit(1)
