# ADR-003：M0 之后的技术栈修订

- **状态**：提议中。条目 1、2 随 M0.5 生效；其余条目由产品负责人确认后逐条生效。
- **日期**：2026-11-08
- **修订对象**：ADR-001

## 背景

M0 验证了存储与恢复，但产品最大的未知数还没有验证：覆盖层手感、WebView 书写延迟、屏幕共享兼容性。ADR-001 列出的依赖面很宽（三套 ML 运行时、两种画布引擎候选、CRDT、本地 HTTP 网关、Typst 等），一部分与"领域层由 Rust 拥有"的分层相冲突。本 ADR 收窄选型，让每个依赖都对应一个当前阶段的需求。

## 决策

1. **书写热路径放在前端（已生效）**：指针采样、1€ 平滑、笔锋、实时渲染、命中测试都在 TypeScript 中完成。Rust 只接收抬笔后的完整笔迹命令。逐点走 IPC 会增加延迟。`coboard-domain/src/ink.rs` 中的算法保留为参考实现和校验用途。
2. **前端乐观显示 + 串行提交队列（已生效）**：界面不再在保存期间锁定。已发出、未确认的编辑先在本地显示；请求按顺序串行发送；失败时保留队列并可原样重试（同一 `request_id`）。
3. **画布渲染：Canvas2D 起步，PixiJS（WebGL）备选；不用 tldraw**。tldraw 自带 store、撤销和形状系统，与 Rust 拥有文档的分层冲突；其 SDK 生产使用需商业许可（以官网最新条款为准）。若 Canvas2D 在万级笔迹下无法满足帧预算，再引入 PixiJS。macOS 13 / 14 的 WKWebView 不保证 WebGPU，按 WebGL 规划。
4. **Loro 暂缓**：当前 `crdt.rs` 把节点整体存成 JSON 字符串，没有发挥 CRDT 的价值，只增加了一份存储。单机阶段由 SQLite 命令日志加快照承担恢复与时间线；做局域网协同时再评估是否引入。
5. **本地资源改用 Tauri 自定义 URI 协议**（`register_asynchronous_uri_scheme_protocol`）替代 Axum 端口网关：不开端口，不需要 token 和 CORS，攻击面更小。Axum 等局域网能力真正立项时再引入。
6. **文档节点从 JSONML 位置数组迁移为带 `type` 的对象**，配合 schema 版本迁移。前端类型由 Rust 生成（`ts-rs` 或 `tauri-specta`），不再手写 `types.ts`。
7. **平台桥接：`objc2` + 小型 Swift 桥**。ScreenCaptureKit 用 `objc2` 调用；Swift-only 的新系统 API（Vision 文档识别、SpeechAnalyzer 等）通过 Swift 包暴露 C ABI 后调用。
8. **最低系统版本从 macOS 13 评估提升到 14**：单帧截图 `SCScreenshotManager` 从 14 起可用。
9. **本地 ML 收窄**：第一阶段只用系统 Vision；公式识别选一个 `ort` 模型；移除 `candle`。转写先评估系统 Speech 能力，再考虑 `whisper-rs`。YOLO、PaddleOCR、BGE、`sqlite-vec` 移出近期范围。
10. **PDF 改用 PDFKit** 渲染与文本选区（系统自带，不需要打包 pdfium）。`typst` 导出推迟到 DAT-08 立项。
11. **空 crate 收敛**：`coboard-ai-client`、`coboard-pdf-export`、`coboard-vision-ml` 有实现时再保留；在此之前可以删除，减少维护面。考虑把 `src-tauri/lib.rs` 中的会话编排抽成 `coboard-app` crate，以便不启动 GUI 也能测试。
12. **分发方式需明确**：`macOSPrivateApi: true`（透明窗口所需）不能上架 Mac App Store。默认按 Developer ID 签名加公证分发。

## 已知限制（M0.5）

- 每次提交都返回完整文档，笔迹多时 IPC 负载随文档增长。后续改为返回增量或只返回修订号与撤销状态。
- 公式只显示 LaTeX 源码，渲染待 M3 引入 KaTeX。

## 验证

- 条目 1–3：M0.5 在 Apple Silicon 上实测启动到第一笔、连续书写帧耗时，并测试保存失败时不丢笔迹。
- 条目 7、8：M1 覆盖层原型与会议软件兼容矩阵。
