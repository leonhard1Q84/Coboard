"""Insert exact endpoint pen lifts into known development ink, without new edges.

These are same-source regression transforms, never independent natural word data.
python3 generate-multipen-regressions.py NEW_OUTPUT_JSON
"""
import json
from pathlib import Path
import sys

source = Path(__file__).with_name("connected-fixtures.json")
output = []
for sample in json.loads(source.read_text()):
    trajectory = sample["strokes"][0]
    for pens in [2, 3]:
        cuts = [int(len(trajectory) * i / pens + 0.5) for i in range(pens + 1)]
        output.append({**sample, "name": f"{sample['name']}-penlifts-{pens}",
                       "strokes": [trajectory[cuts[i]:cuts[i + 1] + 1] for i in range(pens)],
                       "role": "development-transform", "incremental": True})
with Path(sys.argv[1]).open("x") as stream:
    json.dump(output, stream, ensure_ascii=False, separators=(",", ":"))
    stream.write("\n")
