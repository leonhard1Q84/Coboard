# ADR-001: 全栈技术选型、覆盖层三层架构、结构化存储与本地 ML 管线

- **状态**：已采纳（待阶段 1 原型基准实测）；部分条目由 [ADR-003](ADR-003-stack-revisions-after-m0.md) 修订
- **日期**：2026-11-08
- **关联规范**：`AGENTS.md`（分层架构、面向失败的数据可靠性、启动与书写性能预算）、`README.md`

---

## 1. 背景与核心问题

Coboard 的核心差异化场景是**“在 macOS 任意已打开内容上方即时圈取素材、固定前置条件、调节蒙版并展开公式/图形推导讲解，随后无缝沉淀为结构化文档”**。

如果仅停留在“使用 Rust 构建核心”的抽象描述，工程落地会面临四个具体架构抉择：
1. **覆盖层交互模型**：如何在“不脱离原文档上下文”与“提供干净充足的推导演算空间”之间兼顾，避免引入笨重的分屏抽屉？
2. **画布与笔刷渲染栈**：如何兼顾复杂富文本/公式块交互排版、专业压感/速度笔锋手感、激光笔动态消散与万级笔迹的大画布几何性能？
3. **文档表示与持久化模型**：如何设计存储格式，使其同时支持图文公式混排、识别结果与原图底稿双态绑定（`OVR-12`）、毫秒级增量落盘（`DAT-01`）、崩溃自愈（`DAT-03`）以及笔迹与录音时间轴双向回放（`REC-05`）？
4. **本地识别与服务通信栈**：如何在完全离线的前提下完成选区智能分类、OCR、公式转 LaTeX 与语音转写，并为前端画布及跨设备协同提供高吞吐数据通道？

---

## 2. 决策方案

### 2.1 覆盖层三层渲染架构与可调蒙版（`OVR-16`）

放弃割裂屏幕空间的“侧边抽屉演算板”方案，采用**全屏三层叠加结构**：
1. **底层（穿透桌面层）**：macOS 原生应用窗口（浏览器、PDF 阅读器、IDE 等）。
2. **中间层（可调蒙版层 Backdrop Layer）**：位于底层屏幕与顶层演算对象之间，支持无级调节**压暗不透明度（Opacity 0%–95%）、背景去饱和度（Desaturation）与背景模糊度（Backdrop Blur）**，并支持按住快捷键瞬时归零透视底层。
3. **顶层（演算与素材层）**：圈取并固定（Pin）的文字块、LaTeX 公式块、截图卡片，以及连线、手写推导笔迹和激光笔轨迹。

**优势**：
- 蒙版为 0% 时，用户直接在原文档上指读、圈取关键公式或条件；
- 展开多步推导时，拉高蒙版浓度即可将底层杂乱文字压暗退后，而位于第 3 层的浮动卡片与推导笔迹保持 100% 高亮锐利，全屏瞬时转化为干净的推导黑板，零布局切换成本。

---

### 2.2 宿主、画布、笔刷与几何计算双擎架构

采用 **Tauri v2（`objc2` 原生窗口桥接）+ Web 画布渲染层 + Rust 几何/存储/ML 核心引擎** 的混合双擎架构：

1. **macOS 原生透明穿透与无闪烁截图（`crates/coboard-macos`）**
   - 使用 `objc2` / `objc2-app-kit` 配置 `NSPanel`（`NSWindowStyleMaskNonactivatingPanel` + `NSWindowCollectionBehaviorCanJoinAllSpaces | FullScreenAuxiliary`），呼出覆盖层时不抢夺底层应用焦点，原生适配全屏应用与多显示器。
   - 使用 `NSWindow.setIgnoresMouseEvents` 实现绘制与鼠标穿透（`OVR-04`）瞬时切换。
   - 使用 macOS **`ScreenCaptureKit`** 的 `SCContentFilter(desktopIndependentWindow: / excludingWindows:)` **直接排除 Coboard 自身覆盖层窗口**：即使覆盖层开启了高浓度压暗蒙版或写满笔迹，框选取材时也无需隐藏覆盖层，直接零闪烁截取出底层应用 100% 纯净的原图。
2. **前端画布与富文本公式编辑器（`apps/coboard-desktop`）**
   - 框架：**React 19 + TypeScript + Zustand**。
   - 画布引擎：基于 **`tldraw` Engine（深度定制）或 `PixiJS v8 (WebGPU)`** 承载无限画布视口、场景帧（`CAN-17/18`）、智能连线跟随（`LAY-01/02`）与多选变换控制框。
   - 富文本与公式交互：**`ProseMirror` (`Tiptap`)** 承载结构化文本块，配合 **`KaTeX`**（高速公式渲染）与 **`MathLive`**（可视化交互式 LaTeX 公式编辑与校正 `OCR-04`）。
3. **专业笔刷与 Rust 几何计算内核（`crates/coboard-domain`）**
   - **采样滤波**：输入点流先经 **`1€ Filter`（一阶欧元自适应低通滤波器）** 平滑，消除鼠标/触控板慢速书写时的锯齿抖动，同时保持快速运笔零延迟。
   - **动态笔锋与激光笔**：基于 **`perfect-freehand`** 与 Catmull-Rom 样条生成压感/速度可变宽轮廓网格；激光笔（`INK-09` / `OVR-09`）采用独立的时间戳衰减粒子队列（1.5 秒平滑收尾消散），不写入持久化文档状态。
   - **手绘图形规整與空间索引**：使用 Rust **`kurbo` + `geo`** 及 `$P` 点云识别器实现停顿 300ms 自动规整为直线、箭头、矩形、椭圆（`INK-10`）；使用 **`i_overlay`** 实现像素橡皮擦（`INK-03`）对矢量笔画轮廓的多边形布尔切分；使用 **`rstar` (R\*-Tree)** 维护万级笔画与对象的空间索引，保障微秒级视口裁剪与套索命中检测（`OBJ-04`）。

---

### 2.3 四位一体存储架构：JSONML AST + Loro CRDT + SQLite WAL + BLAKE3 CAS

为杜绝单一大 JSON 文件反复全量序列化带来的 I/O 卡顿与损坏风险，`crates/coboard-storage` 采用以下四层存储设计：

1. **结构化文档语法树（JSONML / Typed AST）**
   - 画布场景图与复合推导卡片采用带严格 Schema 版本号的 **JSONML / ProseMirror AST** 结构化节点树表示：
     ```json
     ["derivation_card", { "id": "obj_01", "source_asset": "blake3:7c9e...", "source_rect": [120, 340, 480, 90], "pinned": true },
       ["paragraph", ["text", "由守恒条件代入得："]],
       ["math_block", { "latex": "\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0}", "confidence": 0.98, "verified": true }]
     ]
     ```
   - **原图追溯绑定（`OVR-12` / `OCR-05`）**：每个识别生成的文字块或公式块在 AST 节点属性中直接持有 `source_asset`（原始截图切片的 `BLAKE3` 哈希）与屏幕/PDF 来源坐标，支持一键在“可编辑 AST 视图”与“原始截图底稿”之间切换核对。
2. **增量操作日志与时间旅行（`Loro` CRDT）**
   - 采用 Rust 原生 **`loro`** 状态引擎管理文档状态树与增量操作日志（OpLog）。
   - 支撑多窗口状态实时同步、局域网伴侣屏协同，并支持按时间戳毫秒级 Checkout 历史状态，直接驱动 `REC-01` 操作时间线与 `REC-05` 笔迹回放。
3. **持久化数据库（`SQLite` WAL + FTS5 + `sqlite-vec`）**
   - 每个 `.coboard` 文档包内含 `document.db`（开启 `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;`）：
     - `snapshots` 表：定期保存 `zstd` 压缩的完整场景树快照，加速冷启动加载；
     - `oplog` 表：Append-only 增量操作记录，每次编辑命令提交后毫秒级落盘，支撑异常退出自愈重放（`DAT-03`）；
     - `timeline_events` 表：讲解事件、视口跳转与音频字词级时间戳对齐表（`REC-04/05`）；
     - `fts_index`（SQLite FTS5）：全文检索键入文字、OCR 文本、LaTeX 源码与转写稿；
     - `vec_index`（`sqlite-vec`）：存储本地 Embedding 向量，支撑语义搜索与 `LAY-07` 语义吸附。
4. **内容寻址资源池（`BLAKE3` CAS Assets）**
   - 截图原图、导入图片、PDF 原文件与 Opus 录音分片均计算 `BLAKE3` 哈希，存入 `assets/<hash_prefix>/<hash>.<ext>`。
   - 写入严格遵循“同目录临时文件写入 $\rightarrow$ `fsync` 校验 $\rightarrow$ `rename` 原子替换”协议，引用计数管理生命周期，确保崩溃或断电绝不损坏已有媒体资源。

---

### 2.4 本地 ML 推理管线与 PDF 排版引擎

1. **Apple Silicon 本地硬件加速推理（`crates/coboard-vision-ml`）**
   - 运行时：Rust **`ort` (ONNX Runtime，开启 CoreML / Metal Execution Provider)** + **`candle`**（Metal GPU 加速）。
   - **选区智能分类器（`OVR-10/11`）**：轻量级版面检测模型 **`YOLOv8n-DocLayNet` (ONNX)** 结合 `Vision` 文本行密度，在 10ms 内判定圈选区域属于“纯文字”、“数学公式”还是“图表/代码”，自动分流为文字块、LaTeX 公式块或截图块。
   - **离线文字识别（`OCR-01/02`）**：优先调用 macOS 原生 **`Vision` (`VNRecognizeTextRequest`)**（零模型体积、ANE 硬件加速）；手写复杂场景可按需加载 **`PaddleOCR-v4` (ONNX)**。
   - **离线公式转 LaTeX（`OCR-03`）**：采用 **`UniMERNet-Tiny` / `Texify` (INT8 量化 ONNX)**，后台线程推理后输出 LaTeX AST。
   - **离线语音转写与音画对齐（`REC-03/04`）**：采用 **`Silero-VAD`** 过滤静音 + **`whisper-rs` (`whisper.cpp` Metal 加速)** 输出带字词级（Word-level）毫秒时间戳的转写结果，与 `timeline_events` 中的笔迹时间戳精确对齐。
   - **语义吸附（`LAY-07`）**：采用 **`BGE-small-zh-v1.5` (ONNX)** 计算公式块与注释块的语义相关度，辅助几何吸附引擎完成智能分组对齐。
2. **PDF 解析与出版级导出（`crates/coboard-pdf-export`）**
   - 导入与批注（`MAT-05~09`）：使用 **`pdfium-render`** 按视口缩放级别异步分块光栅化 PDF 页面，并提取底层文本选区与坐标。
   - 推导文档导出（`DAT-08` / `AI-07`）：引入 Rust 原生排版引擎 **`typst`**，将画布上的 JSONML 推导卡片、LaTeX 公式与 AI 生成的结构化笔记直接编译为出版级矢量 PDF。

---

### 2.5 本地服务网关（`Axum`）与联网 AI 客户端

1. **`Axum` 本地流式网关与跨端伴侣协同（`crates/coboard-server`）**
   - 基于 **`axum` + `tower` + `tokio-tungstenite`** 构建本地服务层：
     - **零拷贝流式资源传输**：高清截图纹理、PDF 页面瓦片与录音流通过本地 HTTP Range / 自定义协议流式供给前端画布，规避 IPC JSON 序列化大二进制块的开销；
     - **局域网伴侣屏协同（Companion Mode）**：通过 WebSocket + `Loro` CRDT 增量同步，支持用户使用 iPad 扫码连接 Mac 当前画布，实现“Mac 屏幕展示推导全局、iPad 用 Apple Pencil 实时手写公式”；
     - **无头集成测试入口**：支持在 CI 或开发环境中不启动 GUI 直接对存储、OCR、公式识别与 AI 管线进行自动化验收测试。
2. **联网 AI 客户端适配器（`crates/coboard-ai-client`）**
   - 基于 **`reqwest` + `tokio` + `eventsource-stream`** 封装多厂商 LLM / 多模态接口，严格执行 Token/图片尺寸预算裁剪、输入哈希缓存、分层超时与退避重试；API 密钥通过 **`keyring`** 存储于 macOS Keychain。

---

## 3. 权衡与取舍（Trade-offs）

1. **为什么不用纯 Rust GUI（如 `iced` / `egui` / 纯 `wgpu`）手写全部富文本与画布交互？**
   - 推导场景高度依赖富文本混排、中文输入法（IME）光标合成、交互式 LaTeX 公式编辑（`MathLive`）以及复杂对象控制框。纯 Rust GUI 在富文本与数学公式交互编辑上生态尚不成熟；采用 Tauri v2 + Web 画布层 + Rust 核心底座，既能直接复用 `ProseMirror` / `KaTeX` / `MathLive` / `tldraw` 的成熟交互，又能用 Rust 守住 `ScreenCaptureKit` 无闪烁截图、SQLite WAL + `Loro` 存储可靠性与本地 CoreML 推理性能。
2. **为什么同时保留 `Tauri IPC` 与 `Axum` 服务层？**
   - 高频轻量控制命令（如穿透切换、窗口层级、快捷键事件）走 Tauri IPC 延迟最低；而大体积媒体流（PDF 瓦片、音频流、高清截图）和局域网 iPad 伴侣屏 WebSocket 同步走 `Axum` 架构更清晰，且天然解耦了 GUI 与后端核心的可测试性。
3. **本地 ML 模型体积控制**
   - 第一阶段默认仅依赖 macOS 系统内置的 `Vision` 框架（0 MB 额外体积）即可跑通智能圈取文字与截图分流；公式识别（`UniMERNet`）与离线语音转写（`Whisper`）模型作为按需下载组件（对应 `OCR-06` 资源状态管理），避免初始安装包膨胀。

---

## 4. 验证指标（阶段 1 原型验收基线）

在阶段 1 原型实现中，须在 Apple Silicon Mac 上实测并验证以下指标：
- **全局快捷键呼出到可落笔耗时**：$< 50\text{ ms}$（窗口预热驻留状态下 $< 16\text{ ms}$）。
- **绘制模式与鼠标穿透切换耗时**：$< 5\text{ ms}$。
- **可调蒙版（`OVR-16`）浓度调节帧率**：满屏 60/120fps（ProMotion）无掉帧。
- **`ScreenCaptureKit` 排除自身覆盖层截图 + `Vision` OCR 端到端耗时**：单选区 $< 120\text{ ms}$，且屏幕零闪烁。
- **增量 OpLog 写入 SQLite WAL 延迟**：单笔提交 $< 3\text{ ms}$，模拟 `kill -9` 强制终止后重启 100% 恢复已提交笔迹与卡片。
