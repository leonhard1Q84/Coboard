"""Same user trajectory under deterministic transforms; development data only.
Usage: python3 generate-connected-variants.py OUTPUT_JSON
"""
import json
import sys
from pathlib import Path

originals = json.loads((Path(__file__).with_name('connected-fixtures.json')).read_text())
variants = []
for original in originals:
    variants.append(original)
    s = original['strokes'][0]
    word = original['expected']
    for scale in [.5, 1, 2]:
        for shear in [-.12, 0, .12]:
            for density in [1, 3]:
                points = []
                for a, b in zip(s, s[1:]):
                    for k in range(density):
                        t = k / density
                        x, y = [a[j] + (b[j] - a[j]) * t for j in range(2)]
                        points.append([scale * (x + shear * y) + 123, scale * y - 455])
                x, y = s[-1]
                points.append([scale * (x + shear * y) + 123, scale * y - 455])
                variants.append({'name': f'{word}-scale{scale}-shear{shear}-density{density}', 'expected': word, 'strokes': [points]})
Path(sys.argv[1]).write_text(json.dumps(variants) + '\n')
