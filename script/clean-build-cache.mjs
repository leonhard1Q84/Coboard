import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Refuse to remove a live executable or race an ongoing build. Failure to
// inspect processes is an error, never evidence that cleaning is safe.
const processes = spawnSync('ps', ['-axo', 'comm=,args='], { encoding: 'utf8' });
if (processes.error || processes.status !== 0) {
  console.error('无法检查开发进程，未清理。请在本机终端运行此命令。');
  process.exit(1);
}
if (processes.stdout.split('\n').some((line) =>
  /(?:^|\/)coboard-desktop(?:\s|$)/.test(line) ||
  /(?:^|\/)cargo\s/.test(line) ||
  /(?:^|\/)tauri\s+(?:dev|build)(?:\s|$)/.test(line))) {
  console.error('请保存内容并退出 Coboard、Tauri 开发会话和 Cargo 构建后再清理。未删除任何文件。');
  process.exit(1);
}

// Run from the same directory as Tauri so relative CARGO_TARGET_DIR resolves
// identically. Cargo owns the paths; no recursive deletion of user input.
const result = spawnSync('cargo', ['clean', '--locked', '--profile', 'dev'], {
  cwd: resolve(root, 'apps/coboard-desktop/src-tauri'),
  stdio: 'inherit',
});
if (result.error) console.error(`无法清理构建缓存：${result.error.message}`);
process.exitCode = result.status ?? 1;
if (process.exitCode === 0) {
  console.log('已清理调试构建缓存与旧调试应用；release 应用和本地文档保留。下次开发需重新编译。');
}
