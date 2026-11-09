"""Summarize the complete session replay, retaining every trial-zero record.
Usage: python3 summarize-connected.py JSONL_OR_GZ > SUMMARY_JSON
"""
import collections
import gzip
import hashlib
import json
import math
import sys
from pathlib import Path

source = Path(sys.argv[1])
raw = gzip.decompress(source.read_bytes()) if source.suffix == '.gz' else source.read_bytes()
rows = [json.loads(line) for line in raw.splitlines()]
groups = collections.defaultdict(list)
for row in rows:
    if row.get('kind') == 'recognize' and row['trial'] > 0 and row['final']:
        groups[row['sample']].append(row)


def percentile(values, q):
    values = sorted(values)
    return values[math.ceil(len(values) * q)-1]


summary = {'scope': 'User trajectories and deterministic development transforms; same Rust session as desktop; no IPC, pen-up, paint or display timing; not held-out word accuracy',
           'raw_sha256': hashlib.sha256(raw).hexdigest(), 'preparation': rows[0], 'samples': []}
for name, group in groups.items():
    expected = group[0]['expected']
    baseline = next(r for r in rows if r.get('kind') == 'baseline' and r['sample'] == name)
    times = [r['wall_ms'] for r in group]
    summary['samples'].append({'name': name, 'expected': expected, 'trials': len(group),
        'top1': sorted({r['response']['candidates'][0]['text'] for r in group}),
        'correct_trials': sum(r['response']['candidates'][0]['text'] == expected for r in group),
        'baseline_top1': baseline['output']['candidates'][0]['text'],
        'p50_ms': percentile(times, .5), 'p95_ms': percentile(times, .95),
        'retry_p95_ms': percentile([r['retry_ms'] for r in group], .95),
        'first_trial_wall_ms': next(r['wall_ms'] for r in rows if r.get('kind') == 'recognize' and r['sample'] == name and r['trial'] == 0 and r['final'])})
summary['correct_samples'] = sum(s['correct_trials'] == s['trials'] for s in summary['samples'])
print(json.dumps(summary, ensure_ascii=False, indent=2))
