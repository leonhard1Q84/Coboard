"""Build an offline coverage suite; composed words are explicitly NOT cursive data.

python3 build-common-eval.py UJI_TEST_JSON OUTPUT_JSON [WRITERS=20]
Uses only already-imported, pinned UJI data and existing development regressions.
No model calls, tuning, downloads, or changes to user documents.
"""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent


def compose(glyphs):
    """Same writer/repetition, uniform height 80, baseline 100, fixed 18 gap.

    Coordinates remain within each glyph's original stroke topology. This is
    artificial typesetting of isolated ink, not a person's word or pen rhythm.
    """
    out, cursor = [], 0.0
    for glyph in glyphs:
        points = [p for s in glyph["strokes"] for p in s]
        low_x, high_x = min(p[0] for p in points), max(p[0] for p in points)
        low_y, high_y = min(p[1] for p in points), max(p[1] for p in points)
        scale = 80 / max(high_y - low_y, 1)
        out.extend([[[cursor + (x - low_x) * scale, 100 + (y - high_y) * scale]
                     for x, y in stroke] for stroke in glyph["strokes"]])
        cursor += (high_x - low_x) * scale + 18
    return out


def build(source, writers=20):
    raw = source.read_bytes()
    manifest = json.loads((ROOT / "human-uji-manifest.json").read_text())
    if hashlib.sha256(raw).hexdigest() != manifest["converted_sha256"]:
        raise ValueError("UJI converted checksum mismatch; use pinned human-import-uji.py")
    originals = json.loads(raw)
    all_writers = sorted({s["writer"] for s in originals})
    if not 1 <= writers <= len(all_writers):
        raise ValueError("WRITERS must be 1..20")
    selected = set(all_writers[:writers])
    samples = []
    for s in originals:
        if s["writer"] not in selected:
            continue
        label = s["expected"]
        group = "digit" if label.isdigit() else "uppercase" if label.isupper() else "lowercase"
        samples.append({"name": s["name"], "writer": s["writer"], "group": group,
                        "role": "human-isolated", "target": label, "expected": label,
                        "strokes": s["strokes"], "incremental": False})
    lookup = {(s["writer"], s["session"].rsplit("-", 1)[-1], s["expected"]): s for s in originals}
    targets = json.loads((ROOT / "common-targets.json").read_text())
    for group in ["english-word", "number-string", "ambiguous"]:
        for index, target in enumerate(targets[group]):
            # Punctuation has no source in this UJI subset; leave an explicit gap.
            if not all(c.isascii() and c.isalnum() for c in target):
                continue
            for writer in sorted(selected):
                for repetition in ["01", "02"]:
                    glyphs = [lookup[writer, repetition, c] for c in target]
                    samples.append({"name": f"composed-{group}-{index}-{writer}-{repetition}",
                                    "writer": writer, "group": group, "role": "composed-diagnostic",
                                    "target": target, "expected": target, "strokes": compose(glyphs),
                                    # Exercise append/cache behavior on every stroke of two fixed writers.
                                    "incremental": writer in all_writers[:2] and repetition == "01"})
    for s in json.loads((ROOT / "connected-fixtures.json").read_text()):
        samples.append({**s, "writer": "user-development", "role": "development-regression",
                        "group": "chinese-phrase" if s["expected"] == "我们" else "english-word",
                        "target": s["expected"], "incremental": True})
    return samples


if __name__ == "__main__":
    source, output = map(Path, sys.argv[1:3])
    samples = build(source, int(sys.argv[3]) if len(sys.argv) > 3 else 20)
    output.write_text(json.dumps(samples, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(json.dumps({"samples": len(samples), "input_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                      "roles": {r: sum(s["role"] == r for s in samples) for r in sorted({s["role"] for s in samples})}}))
