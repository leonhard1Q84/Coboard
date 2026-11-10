import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scripts = dirname(fileURLToPath(import.meta.url));
const run = (name, args = [], env = process.env) => spawnSync(process.execPath, [join(scripts, name), ...args], {
  encoding: 'utf8', env,
});

test('app budget rejects missing binaries and oversize bundles, including resources', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'coboard-size-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const app = join(fixture, 'Test App.app');
  const macos = join(app, 'Contents', 'MacOS');
  mkdirSync(macos, { recursive: true });
  assert.equal(run('check-app-size.mjs', [app]).status, 1);
  writeFileSync(join(macos, 'coboard-desktop'), 'binary');
  assert.equal(run('check-app-size.mjs', [app]).status, 0);
  const resource = join(app, 'Contents', 'large-resource');
  writeFileSync(resource, '');
  truncateSync(resource, 30 * 1024 ** 2);
  const oversized = run('check-app-size.mjs', [app]);
  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /超出体积预算/);
});

test('cache cleanup refuses running apps, builds and failed process inspection', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'coboard-clean-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  // Stub both commands so these tests can never invoke real cargo clean.
  writeFileSync(join(fixture, 'ps'), '#!/bin/sh\nprintf "%s\\n" "$COBOARD_TEST_PROCESSES"\nexit "$COBOARD_TEST_PS_STATUS"\n', { mode: 0o755 });
  const log = join(fixture, 'cargo-call');
  writeFileSync(join(fixture, 'cargo'), '#!/bin/sh\npwd > "$COBOARD_TEST_LOG"\nprintf "%s\\n" "$@" >> "$COBOARD_TEST_LOG"\nexit "$COBOARD_TEST_CARGO_STATUS"\n', { mode: 0o755 });
  const env = {
    ...process.env, PATH: fixture, COBOARD_TEST_LOG: log,
    COBOARD_TEST_PS_STATUS: '0', COBOARD_TEST_CARGO_STATUS: '0',
  };
  for (const process of [
    '/repo/target/debug/coboard-desktop /repo/target/debug/coboard-desktop',
    '/repo/Coboard Ink Preview.app/Contents/MacOS/coboard-desktop',
    '/opt/bin/cargo cargo test --locked',
    'tauri node /repo/node_modules/.bin/tauri dev',
  ]) {
    const result = run('clean-build-cache.mjs', [], { ...env, COBOARD_TEST_PROCESSES: process });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /未删除任何文件/);
  }
  assert.throws(() => readFileSync(log), { code: 'ENOENT' });
  assert.equal(run('clean-build-cache.mjs', [], { ...env, COBOARD_TEST_PS_STATUS: '1' }).status, 1);
  assert.throws(() => readFileSync(log), { code: 'ENOENT' });

  const result = run('clean-build-cache.mjs', [], { ...env, COBOARD_TEST_PROCESSES: '/usr/bin/unrelated' });
  assert.equal(result.status, 0);
  assert.equal(readFileSync(log, 'utf8'), `${resolve(scripts, '../apps/coboard-desktop/src-tauri')}\nclean\n--locked\n--profile\ndev\n`);
  const failed = run('clean-build-cache.mjs', [], { ...env, COBOARD_TEST_CARGO_STATUS: '7' });
  assert.equal(failed.status, 7);
  assert.doesNotMatch(failed.stdout, /已清理/);
});
