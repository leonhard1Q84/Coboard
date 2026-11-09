"""Convert official UJIpenchars2 test writers, preserving their original XY ink.

Usage: python3 human-import-uji.py UCI_ZIP OUTPUT_JSON
No labels enter preprocessing. Selection: every ASCII alphanumeric sample from
all official tst writers, both repetitions (20 * 62 * 2 = 2480 samples).
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

EXPECTED_ZIP_SHA256 = "0881b522911b99d9922820289441b50fd3d307f71cd7f9cc70e86872424a5f90"
source = Path(sys.argv[1])
output = Path(sys.argv[2])
raw = source.read_bytes()
if hashlib.sha256(raw).hexdigest() != EXPECTED_ZIP_SHA256:
    raise ValueError("Unexpected UJI ZIP checksum; review source before importing")
with zipfile.ZipFile(source) as archive:
    text = archive.read("ujipenchars2.txt")
lines = iter(text.decode("utf-8").splitlines())
samples = []
for line in lines:
    if not line.startswith("WORD "):
        continue
    _, label, session = line.split()
    tag, count = next(lines).split()
    if tag != "NUMSTROKES":
        raise ValueError("missing NUMSTROKES")
    strokes = []
    for _ in range(int(count)):
        head, coordinates = next(lines).split("#")
        tag, n = head.split()
        xy = [int(x) for x in coordinates.split()]
        if tag != "POINTS" or len(xy) != 2 * int(n) or not xy:
            raise ValueError("invalid POINTS")
        strokes.append([xy[i:i + 2] for i in range(0, len(xy), 2)])
    if session.startswith("tst_") and len(label) == 1 and label.isascii() and label.isalnum():
        samples.append({
            "name": f"uji2-{session}-{ord(label):02x}",
            "writer": session.rsplit("-", 1)[0],
            "session": session,
            "expected": label,
            "strokes": strokes,
            "glyph_indices": [list(range(len(strokes)))],
        })
if len(samples) != 2480 or len({s["writer"] for s in samples}) != 20:
    raise ValueError("unexpected sample/writer count")
output.write_text(json.dumps(samples, ensure_ascii=False, separators=(",", ":")) + "\n")
manifest = {
    "dataset": "UJI Pen Characters (Version 2)",
    "creators": ["F. Prat", "M. J. Castro", "D. Llorens", "A. Marzal", "J. M. Vilar"],
    "doi": "10.24432/C5FG8S",
    "source": "https://archive.ics.uci.edu/dataset/177/uji+pen+characters+version+2",
    "download": "https://archive.ics.uci.edu/static/public/177/uji+pen+characters+version+2.zip",
    "license": "CC BY 4.0, per official UCI dataset page checked 2026-11-09",
    "license_url": "https://creativecommons.org/licenses/by/4.0/",
    "zip_sha256": EXPECTED_ZIP_SHA256,
    "source_text_sha256": hashlib.sha256(text).hexdigest(),
    "converted_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
    "selection": "All ASCII letters and digits in the official tst writer split; both repetitions; original file order",
    "samples": len(samples),
    "writers": len({s["writer"] for s in samples}),
    "preprocessing": "None. Original pen-up boundaries, duplicate points, coordinate orientation and integer XY preserved.",
    "scope": "Isolated Latin letters and digits from human stylus input, not Chinese, word segmentation, mixed lines or UI latency. Dataset/model training overlap unknown.",
}
output.with_suffix(".manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(manifest, ensure_ascii=False, indent=2))
