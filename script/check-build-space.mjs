import { statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Tauri runs Cargo from src-tauri, so relative CARGO_TARGET_DIR values must
// use that directory rather than the npm hook's working directory.
const target = process.env.CARGO_TARGET_DIR
  ? resolve(root, 'apps/coboard-desktop/src-tauri', process.env.CARGO_TARGET_DIR)
  : resolve(root, 'target');
const gibibyte = 1024 ** 3;

// A configured target directory may not exist on the first build. Inspect its
// nearest existing parent so the check still uses the destination filesystem.
let destination = target;
try {
  let stats;
  for (;;) {
    try {
      stats = statfsSync(destination);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(destination) === destination) throw error;
      destination = dirname(destination);
    }
  }
  const available = stats.bavail * stats.bsize;
  if (available < gibibyte) {
    console.error(
      `构建已停止：构建盘仅剩 ${(available / gibibyte).toFixed(2)} GiB，至少需预留 1 GiB。\n` +
      '请先释放空间；全量构建建议预留 3 GiB 以上。\n' +
      '若此前因磁盘满导致程序损坏，请退出开发进程后在仓库根目录运行 cargo clean，再重新构建。',
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`无法检查构建盘可用空间：${error.message}`);
  process.exitCode = 1;
}
