import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const mibibyte = 1024 ** 2;
const budget = 30 * mibibyte;

// Logical file bytes, independent of APFS compression/clones/block rounding.
function bytes(path) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    return readdirSync(path).reduce((sum, name) => sum + bytes(join(path, name)), 0);
  }
  return stat.size;
}

try {
  if (!process.argv[2]) throw new Error('请指定构建后的 .app 路径');
  const app = resolve(process.argv[2]);
  if (!app.endsWith('.app') || !lstatSync(app).isDirectory()) {
    throw new Error('需要一个已构建的 .app 目录');
  }
  // A missing executable must not pass the budget as an empty/small bundle.
  const executable = join(app, 'Contents/MacOS/coboard-desktop');
  if (!lstatSync(executable).isFile()) throw new Error('应用缺少可执行文件');
  const size = bytes(app);
  console.log(`应用体积：${(size / mibibyte).toFixed(2)} MiB / 预算 30 MiB（文件字节总和）。`);
  if (size > budget) {
    console.error('应用超出体积预算，请检查依赖和打包资源后再交付。');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`无法检查应用体积：${error.message}`);
  process.exitCode = 1;
}
