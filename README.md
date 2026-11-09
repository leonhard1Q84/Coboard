# Coboard

**为屏幕共享而生的 macOS 即时讲解工具。**

开会共享屏幕时，一个快捷键在任何应用上方圈画、激光指示、圈取文字与公式成浮动卡片、压暗背景展开推导；需要一块干净的板时，打开 Coboard 一笔就能写。离线完整可用，联网 AI 只是可选增强。

> **当前状态：基础画布 + M1 覆盖层原型。** 支持圆珠笔、铅笔、钢笔、记号笔、荧光笔、激光笔、擦除、文字与规范图形；覆盖层有模式提示和操作指南。主画布自动保存，屏幕标注暂时只在进程内保留。手写文字的 PaddleOCR 试用已被用户否决，正在验证免费本地替代；系统 Vision 与汉字笔画候选器已完成有界实验，尚无候选通过完整验收，现已接入本地原生增量候选原型，尚未完成自由书写验收。屏幕取材识别与会议软件兼容矩阵尚未完成。下面的能力描述是产品规划，不代表全部可用。

## 两种演示方式

| 会议软件中的共享方式 | 用 Coboard 的什么 | 观众看到 |
| --- | --- | --- |
| 共享整个屏幕 | **屏幕覆盖层**（M1）：在任何应用上方书写、取材、调蒙版 | 原内容 + 你的笔迹和卡片 |
| 只共享某个窗口 | **画布窗口**：启动即可书写的无限画布 | 一块干净的讲解板 |

两种方式共用同一套工具栏、快捷键和笔刷。

操作说明见 [屏幕讲解指南](docs/development/overlay-guide.md)；手写直出的候选引擎与中英文条件见 [引擎调研](docs/development/handwriting-engine-research.md)。

增量空间 DP 已接入 Rust 后台与 Tauri Channel，采用现有本地原生模型；libochwpro 保留为研究候选。独立真人评估中，20 位测试书写者的 2,480 个字母数字首选正确率仅 52.66%，当前引擎未通过可用性验收。采样一致性缺陷已修复，中文、整行自由书写和端到端延迟仍须验证。来源与完整预测见 [真人评估](research/handwriting/human-evaluation.md)，实现及复现见 [增量手写实验](docs/development/incremental-handwriting-prototype.md)。

## 产品原则

- **讲解不中断**：呼出、圈画、穿透切换与取材都不打断讲解；界面在讲解时退到最后。
- **一进来就能画**：启动即画布，默认画笔；保存、恢复、模型都在后台。
- **模式始终可见**：绘制、穿透、激光笔等状态一眼可辨，可瞬时切换。
- **随写随存**：每笔自动持久化，异常退出可恢复；"已保存"只在真正落盘后显示。
- **离线完整**：网络状态不影响创作。

## 文档

| 文档 | 内容 |
| --- | --- |
| [产品定位](docs/product/positioning.md) | 目标用户、竞品与差异化、非目标、成功指标 |
| [功能规格 PRD](docs/product/PRD.md) | 全部功能编号与 P0 / P1 / P2 优先级 |
| [路线图](docs/product/roadmap.md) | M0 → M5 范围与验收 |
| [UI 规范](docs/design/ui-guidelines.md) | 视觉与交互规范、设计令牌 |
| [ADR](docs/decisions/) | 技术选型与存储协议 |
| [M0 实现说明](docs/development/m0-foundation.md) | 已实现范围、实测数据与限制 |
| [AGENTS.md](AGENTS.md) | 协作硬规则与工程细则索引 |

## 本地开发

需要 macOS、Rust、Node.js 与 Xcode Command Line Tools。

```sh
# 仓库根目录：核心测试（无需 GUI）
cargo test --locked
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings

# 仓库根目录：首次安装桌面应用依赖
npm --prefix apps/coboard-desktop ci

# 仓库根目录：启动完整桌面应用（包含 Web 层与本地内核）
npm run dev

# 仓库根目录：仅启动 Web 预览
npm run dev:web

# 前端测试与构建
npm --prefix apps/coboard-desktop test
npm --prefix apps/coboard-desktop run build
```

根目录的 `npm run dev:web` 只启动 Web 层：可以书写，但没有本地内核，界面会显示"未连接本地存储"，不会假装保存成功。在 `apps/coboard-desktop` 目录内，`npm run dev` 仍只启动 Web 层，`npm run tauri dev` 启动完整桌面应用。该目录内执行 `npm run tauri build -- --debug --bundles app` 生成本地调试 `.app`；正式签名与分发尚未配置。

本地 `.app` 默认使用 ad hoc 签名（`signingIdentity = "-"`），封装应用资源并支持本机验证，无需开发者证书。`./script/build_and_run.sh --verify` 会构建、校验完整签名并启动应用；这不代表已完成 Developer ID 签名或 Apple 公证，不能作为对外发行验收。见 [本地签名决策](docs/decisions/ADR-006-local-macos-build-signing.md)。

桌面启动和打包前会检查构建盘空间，少于 1 GiB 时停止；这只是最低余量，全量构建建议预留 3 GiB 以上。若构建出现 `No space left on device`，随后启动又报 `Permission denied`，可能是链接或剥离符号时留下了损坏的程序，不能仅靠 `chmod +x` 修复。退出开发进程、释放空间后，在仓库根目录运行 `cargo clean` 清除可重建产物，再运行 `npm run dev`；文档数据不在 `target` 内，不受此清理影响。
