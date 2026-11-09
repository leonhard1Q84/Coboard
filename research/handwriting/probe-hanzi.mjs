import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const dir = process.argv[2];
if (!dir) throw new Error('Usage: node probe-hanzi.mjs <verified-local-assets> [output.json]');
const fixturePath = fileURLToPath(new URL('../../apps/coboard-desktop/scripts/handwriting-fixtures.json', import.meta.url));
const fixtureBytes = fs.readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes).find(f => f.name === 'vector-chinese');
if (!fixture || fixture.strokes.length !== 7) throw new Error('Expected synthetic Chinese fixture');

// The fixture has a known blank x gap between characters. This split is supplied
// manually for an isolated-character experiment; this is NOT automatic segmentation.
const chars = [{ label: '中', strokeIndices: [0, 1, 2] }, { label: '文', strokeIndices: [3, 4, 5, 6] }];
const inputs = chars.map(({label, strokeIndices}) => ({
  label, strokeIndices, inputType: 'existing synthetic fixture with noncanonical stroke order',
  strokes: strokeIndices.map(i => {
    const [, s] = fixture.strokes[i];
    return s.points.map(p => [s.position.x + p.x, s.position.y + p.y]);
  }),
}));
// One predetermined positive-control attempt. These textbook-style coordinates
// are authored here, not loaded from the recognition model and not tuned to output.
inputs.push({
  label: '中', inputType: 'authored canonical four-stroke positive control',
  strokes: [
    [[60, 65], [60, 175]],
    [[60, 65], [190, 65], [190, 175]],
    [[60, 175], [190, 175]],
    [[125, 20], [125, 230]],
  ],
}, {
  label: '文', inputType: 'authored canonical four-stroke positive control',
  strokes: [
    [[120, 20], [137, 40]],
    [[35, 65], [220, 65]],
    [[185, 65], [165, 120], [135, 165], [90, 200], [40, 230]],
    [[70, 65], [90, 120], [125, 170], [175, 210], [230, 230]],
  ],
});
const sourceMetadata = JSON.parse(fs.readFileSync(`${dir}/sources.json`, 'utf8'));
for (const file of sourceMetadata.files) {
  const bytes = fs.readFileSync(path.join(dir, path.basename(file.path)));
  if (bytes.length !== file.size || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
    throw new Error('Source verification failed: ' + file.path);
  }
}
const loadStart = performance.now();
globalThis.self = globalThis;
// Loading uses local bytes. Any unexpected network use fails immediately.
globalThis.fetch = () => { throw new Error('Network disabled during probe'); };
vm.runInThisContext(fs.readFileSync(`${dir}/hanzi_lookup.js`, 'utf8'), { filename: 'official-hanzi_lookup.js' });
await globalThis.wasm_bindgen(fs.readFileSync(`${dir}/hanzi_lookup_bg.wasm`));
const initialLoadMs = performance.now() - loadStart;
const cases = [];
for (const input of inputs) {
  const start = performance.now();
  const firstTop5 = JSON.parse(globalThis.wasm_bindgen.lookup(input.strokes, 5));
  const firstLookupMs = performance.now() - start;
  const timings = [], outputs = [];
  for (let i = 0; i < 100; i++) {
    const begin = performance.now();
    const matches = JSON.parse(globalThis.wasm_bindgen.lookup(input.strokes, 5));
    timings.push(performance.now() - begin);
    outputs.push(matches);
  }
  const sorted = [...timings].sort((a, b) => a - b);
  cases.push({ ...input, firstTop5, firstLookupMs, warmSamples: timings.length,
    warmP50Ms: sorted[Math.ceil(.50 * sorted.length) - 1],
    warmP95Ms: sorted[Math.ceil(.95 * sorted.length) - 1],
    warmMinMs: sorted[0], warmMaxMs: sorted.at(-1),
    allOutputsIdentical: outputs.every(x => JSON.stringify(x) === JSON.stringify(firstTop5)),
    rawTimingsMs: timings,
  });
}
const result = {
  scope: 'Offline Node.js lookup on two manually separated synthetic single Chinese characters plus two predetermined canonical-stroke positive controls. Not real user handwriting, continuous free writing, automatic character segmentation, mixed English/Chinese, WebKit, or end-to-end UI latency.',
  inputCaveat: '中 has three drawn strokes in the existing fixture (the second stroke includes the bottom horizontal), rather than the four strokes in canonical stroke order.',
  environment: { node: process.version, platform: process.platform, arch: process.arch, osRelease: os.release(), cpu: os.cpus()[0]?.model },
  source: sourceMetadata,
  fixture: { path: fixturePath, sha256: crypto.createHash('sha256').update(fixtureBytes).digest('hex'), name: fixture.name },
  networkEnabledDuringProbe: false,
  initialLoadMs,
  initialLoadScope: 'First loader evaluation, local file reads and WebAssembly instantiation in this Node process. Does not include process startup, network download, or a guaranteed cold disk cache.',
  cases,
};
fs.writeFileSync(process.argv[3] ?? path.join(dir, 'results-replay.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ initialLoadMs, environment: result.environment, inputCaveat: result.inputCaveat,
  cases: cases.map(({rawTimingsMs, strokes, ...rest}) => rest) }, null, 2));
