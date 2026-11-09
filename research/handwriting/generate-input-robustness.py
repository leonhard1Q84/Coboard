"""Create geometric regression inputs, not new handwriting accuracy samples.

Only scale, translation and collinear sampling density change. Labels are copied
for evaluation; the recognizer never receives them. Output is deterministic.
"""
import copy
import json
import sys
from pathlib import Path

source = Path(__file__).with_name('incremental-fixtures.json')
output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/tmp/coboard-input-robustness.json')
result = []
for fixture in json.loads(source.read_text()):
    for scale in (0.1, 0.5, 1, 2):
        for density in (1, 4, 16):
            sample = copy.deepcopy(fixture)
            sample['name'] = f"{fixture['name']}/scale={scale}/density={density}"
            strokes = []
            for stroke in fixture['strokes']:
                points = []
                for a, b in zip(stroke, stroke[1:]):
                    for i in range(density):
                        t = i / density
                        points.append([
                            (a[0] * (1 - t) + b[0] * t) * scale + 100,
                            (a[1] * (1 - t) + b[1] * t) * scale + 200,
                        ])
                points.append([stroke[-1][0] * scale + 100, stroke[-1][1] * scale + 200])
                strokes.append(points)
            sample['strokes'] = strokes
            result.append(sample)
output.write_text(json.dumps(result, ensure_ascii=False) + '\n')
print(f'{len(result)} deterministic regression inputs written to {output}')
