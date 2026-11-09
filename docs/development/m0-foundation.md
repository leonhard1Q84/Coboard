# M0：实现范围与开发入口

日期：2026-11-08。此版本是屏幕推导产品的可运行地基和存储验证入口。

## 已实现

| 模块 | 当前实现 |
| --- | --- |
| `coboard-domain` | 强类型 JSONML、文字／公式／推导卡片／原图来源／笔迹／连线；图不变量、原子多对象命令、修订检查、有限 Undo/Redo |
| `coboard-storage` | `.coboard` 包、单写文件锁、SQLite WAL + FULL 同步、Loro 真增量更新、zstd 快照、BLAKE3 CAS、FTS5、版本／完整性校验、恢复与幂等重试 |
| `coboard-server` | 随机 loopback 端口、临时资源访问 token、受限 CORS、文件校验后异步分段流、HTTP Range、并发限制与关闭 |
| `coboard-desktop` | Tauri v2 IPC 与后台单写会话；React 19 + TypeScript + Zustand；新增文字／LaTeX 源码、命名、选择、步进移动、删除、撤销重做、保存状态、失败重试和启动恢复 |
| `coboard-macos` / `coboard-vision-ml` / `coboard-pdf-export` / `coboard-ai-client` | 已建立 crate 边界；相应原生覆盖层、识别、导出和联网服务尚未实现，无默认权限请求或模型下载 |

> **M0.5 更新**：桌面界面已从对象列表改为“画布 + 悬浮工具栏”。启动即可书写，支持画笔、荧光笔、激光笔、整笔橡皮、选择拖动、文字和 LaTeX 源码、平移缩放。前端改为乐观显示 + 串行提交队列，见 ADR-003。下面“桌面手动验收”的旧步骤由新的一组替代：启动后直接画一笔 → 状态变为“已保存” → 退出重开，笔迹恢复 → ⌘Z 撤销该笔。屏幕覆盖层与可调蒙版仍从 M1 开始实现。

## 命令

从仓库根目录运行：

```sh
cargo test --locked
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings

# 独立子进程 + SIGKILL 的 1,000 命令恢复验收（会输出实测耗时）
cargo test --locked -p coboard-storage --test crash_recovery -- --nocapture

# 原生宿主检查，包含 Tauri API 和 macOS 库
cargo check --locked -p coboard-desktop
```

桌面开发：

```sh
cd apps/coboard-desktop
npm ci
npm test
npm run build
npm run tauri dev

# 包含前端静态资源的原生调试包；不是正式签名／公证发行版
npm run tauri build -- --debug --bundles app
```

构建结果在仓库根目录的 `target/debug/bundle/macos/Coboard.app`。基础工具为 Rust、Node.js、Xcode Command Line Tools；本轮实际使用 Apple M4（Mac16,12，16 GiB 内存）、Rust/Cargo 1.98.0、Node.js 25.6.1、npm 11.9.0、macOS 15.6.1、arm64。依赖版本由 `Cargo.lock` 与 `package-lock.json` 固定。

仓库默认 `cargo test` 运行七个核心 crate，不启动 GUI 或要求 Tauri 桌面环境；`cargo test --workspace` 会额外编译桌面宿主。开发与测试构建关闭调试符号和增量编译，减小本地磁盘占用；性能优化结论应另用 release 在固定条件下验证。

## 桌面手动验收

1. 通过 `npm run tauri dev` 启动，看到“已保存到本机”和初始修订 0；创建已有包时恢复最近已提交修订。
2. 输入一条文字或 LaTeX 源码并点“添加并保存”。等待保存成功，观察对象与修订增加。
3. 点选对象、“右移 24”，确认坐标增加；撤销／重做检查同一对象还原和前进。内容区聚焦时支持 `⌘Z`／`⇧⌘Z`；输入框内仍使用原生文本撤销。
4. 关闭并重新启动，确认内容、坐标与命名恢复；撤销栈从新会话开始。
5. 保存失败时输入草稿和同一请求 ID 保留，“重试同一操作”不重复创建。不要手工删除打开包中的 WAL／SHM。

默认会话位置通过 Tauri `app_data_dir()` 解析，在 macOS 为 `~/Library/Application Support/app.coboard.desktop/workspace.coboard`。本轮只提供一个本地自动恢复会话，文档选择、另存与跨窗口同步入口后续实现。输入框中尚未点击添加的文字不是已提交文档；退出后不会自动恢复该草稿。

单独运行 `npm run dev` 没有 Rust IPC，界面会明确提示内核未连接，不会用浏览器临时数据模拟“保存成功”。原生启动先显示窗口，文档打开／恢复在后台执行；网关失败只禁用媒体流，不阻断文字编辑和保存。

## 自动验收与实际测量

核心测试覆盖：事务失败整体不变、无效几何／来源／未知字段、连线引用完整性、撤销重做与历史上限、Unicode／空格／组合字符路径、FTS 更新、快照与增量恢复、幂等重试、SQL 写失败回滚、真实 `SQLITE_FULL` 故障注入、只读数据库、文件锁、新版本保护、损坏快照／截断日志、缺失／损坏资源及符号链接越界。网关测试覆盖认证与 Range 边界、仅 loopback 监听及关闭；前端测试验证等待持久化确认和失败后的同请求重试。

网关监听测试需要允许创建本地 loopback socket 的执行环境；受限沙盒若禁止 bind，应在获准的本地环境执行，不把该测试跳过或伪报为通过。原生调试包已构建并实际打开，观察到真实 IPC 连接后恢复到修订 0 的空文档；本轮未完成完整 UI 操作回归，以上手动步骤仍作为后续验收清单。

2026-11-08 首轮 debug 实测：独立子进程写入源卡片，再连续提交 500 条两点笔迹与 500 次卡片移动；父进程在收到第 1,001 个修订的确认后发送 SIGKILL，SQLite 没有正常关闭。重启恢复 501 个对象、完整笔迹采样、最终卡片位置与原图字节，恢复后再次提交并重开成功。该轮写入约 15.31 秒，恢复约 56.79 ms，从第 896 修订快照重放 105 条增量。

该数字是当前环境的一次 debug 诊断，包含严格同步和并行构建干扰，不是 p50／p95 基准或 `<3 ms` 单提交验收。实际断电、外接／网络卷、万级大画布、输入延迟、120 fps、屏幕采集及 OCR 耗时均未验收；后续阶段必须分别测量。

## 格式和剩余边界

提交顺序、预算、损坏保护和取舍见 [ADR-002](../decisions/ADR-002-m0-package-commit-and-recovery.md)。M0 保留所有已提交 OpLog、快照和资源，不自动 GC 或迁移；损坏数据库的只读抢救 UI、目录重新授权、另存和跨窗口订阅尚未完成。`timeline_events` 当前仅建表，`sqlite-vec` 随 M5 引入。
