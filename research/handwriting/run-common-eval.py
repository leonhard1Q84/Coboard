"""One-command offline evaluation; creates a new output directory, never overwrites.

python3 run-common-eval.py UJI_TEST_JSON NEW_OUTPUT_DIR [WRITERS=20]
Returns 1 for unmet acceptance gates, 2 for runner/build/data failures.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent


def run():
    source = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    output.mkdir(parents=True, exist_ok=False)
    suite, raw, summary = (output / name for name in ["samples.json", "observed.jsonl", "summary.json"])
    subprocess.run([sys.executable, str(HERE / "build-common-eval.py"), str(source), str(suite),
                    sys.argv[3] if len(sys.argv) > 3 else "20"], check=True)
    source_files = [HERE / "common-targets.json", *sorted((REPO / "crates/coboard-vision-ml/src").glob("*.rs")),
                    REPO / "crates/coboard-vision-ml/data/english-lexicon.txt",
                    *[HERE / n for n in ["build-common-eval.py", "score-common-eval.py", "run-common-eval.py", "connected-fixtures.json"]],
                    REPO / "crates/coboard-vision-ml/examples/common_eval.rs", REPO / "Cargo.lock"]
    model_dir = Path(os.environ.get("COBOARD_HWR_MODEL_DIR",
        "/Users/admin/Documents/Codex/2026-11-09/https-sogou-cn-top-blogs-1213610385/work/handinput"))
    # Record the same env-then-default lookup used by HandwritingEngine.
    if not all((model_dir / n).is_file() for n in ["singleEngine.dll", "lm_HW_PB_7000_kn.arpa.7e9.prune.1e-7.lm.fixed"]):
        raise ValueError("Model directory not available; set COBOARD_HWR_MODEL_DIR explicitly")
    hashes = {str(p.relative_to(REPO)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source_files}
    hashes.update({p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in model_dir.iterdir()
                   if p.name in {"singleEngine.dll", "lm_HW_PB_7000_kn.arpa.7e9.prune.1e-7.lm.fixed"}})
    environment = {"platform": platform.platform(), "machine": platform.machine(), "python": platform.python_version(),
                   "rustc": subprocess.check_output(["rustc", "--version"], text=True).strip(),
                   "profile": "release, offline, locked; sequential CPU; fixed warm-up; filesystem cache/thermal state uncontrolled",
                   "sha256": hashes}
    (output / "environment.json").write_text(json.dumps(environment, indent=2) + "\n")
    with raw.open("w") as stream:
        subprocess.run(["cargo", "run", "--offline", "--locked", "--release", "-p", "coboard-vision-ml",
                        "--example", "common_eval", "--", str(suite)], cwd=REPO, stdout=stream, check=True,
                       env={**os.environ, "COBOARD_HWR_MODEL_DIR": str(model_dir)})
    with summary.open("w") as stream:
        result = subprocess.run([sys.executable, str(HERE / "score-common-eval.py"), str(suite), str(raw), "--check"],
                                stdout=stream)
    if result.returncode not in {0, 1}:
        raise RuntimeError("Scoring/inventory integrity failure")
    report = json.loads(summary.read_text())
    if result.returncode != (0 if report["acceptance"]["passed"] else 1):
        raise RuntimeError("Scorer exit status/report mismatch")
    print(f"Report: {summary}\nAcceptance exit: {result.returncode}")
    return result.returncode


if __name__ == "__main__":
    try:
        sys.exit(run())
    except (OSError, ValueError, subprocess.SubprocessError, RuntimeError) as error:
        print(f"Evaluation failed: {error}", file=sys.stderr)
        sys.exit(2)
