# 手写文字直出：引擎调研

核对日期：2026-11-08。需求：macOS Tauri 覆盖层与画布，中文、英文；选择“手写文字”后直接书写，短暂停顿后在原位自动转为排版文字。默认流程没有圈选、校正弹窗、确认替换。识别失败保留原笔迹；可撤销转换。

## 当前结论

2026-11-09 更新：桌面已采用现有原生模型接入增量空间 DP 与 Tauri 后台候选链路，当前不再使用下述历史 PaddleOCR 定时器方案。实现、测量与剩余准确率限制以 [增量原型报告](incremental-handwriting-prototype.md) 为准。以下保留候选调研与历史阶段结论。

用户明确反馈 PaddleOCR 试用完全不可用，1.2 秒等待无法接受，要求换方案，并进一步选择 **免费、本地**。MyScript 原生不再定为唯一替换方向，也不等待商业 SDK 才继续。系统 Vision 与 `hanzi_lookup` 已完成有界本机验证，Goodnotes 的公开方案已核实，详见 [免费本地候选验证](local-handwriting-evaluation.md) 与 [ADR-005](../decisions/ADR-005-incremental-digital-ink.md)。目前没有候选通过完整自由书写验收；当时的 W 模式仍是旧 PaddleOCR 原型（现已替换，见上述更新）。

代码中的 1.2 秒来自 `HandwritingSession` 的固定 `pauseMs = 1200`：停笔后先等待，再调用识别；它不是推理耗时。历史 54–86ms 的合成样例推理记录排除了这段等待和冷启动，不能证明可用。替换版必须在书写过程中增量识别、允许补笔并更新候选；直接缩短旧定时器会增加拆字风险，不能作为本次交付。

MyScript 官方 macOS C++ API 按需提供；`iinkJS` 已停止维护，推荐 `iinkTS`，两者都连接云端识别，不能满足本次本地要求。备用 [厂商申请稿](myscript-sdk-request.md) 已暂停，未发送。免费路线当前边界：Vision 在既有三组合成样例中均未正确识别；`hanzi_lookup` 的规范中、文单字对照识别正确且函数耗时很低，但非规范笔顺失败，未提供英文词与自由整行分段；不能把它称为已可替换的 Goodnotes 平替。

| 候选 | 中英文 | macOS / 离线 | 结论 |
| --- | --- | --- | --- |
| MyScript iink SDK 4.5 | 官方列出简中、繁中和英文；同句中英混写尚需样本验证 | 官方列 macOS 13+、arm64 / x64、C++ API；支持本机识别 | 商业备选已暂停；用户要求免费本地，未接入或实测 |
| MyScript iinkTS | 多语言 | Web 接口在服务端完成识别，不是本机离线推理 | 不作为本项目默认方案；不发送笔迹到云端 |
| PaddleOCR PP-OCR 系列 | v5 官方明确简中、繁中、英文与手写图像；当前 v6 单模型多语言 | 本机 Worker / WASM 合成样例已验证 | 用户否决直接书写体验，终止本路线；以下历史记录不代表通过验收 |
| Google ML Kit Digital Ink | 官方列中文和英文，支持时间序列笔画 | 本机离线，但官方 SDK 只列 Android / iOS | 不作为原生 macOS Tauri 的直接依赖 |
| Apple Scribble | 语言取决于系统 | UIKit / iOS、iPadOS、Mac Catalyst；不是 AppKit/WKWebView 的笔画识别服务 | 不可直接当本项目的手写引擎 |
| Chromium Handwriting API | 取决于平台模型 | 官方文章说明 ChromeOS 实现及语言限制；本项目使用 WKWebView | 不作为跨平台保证 |

“支持中文与英文”不等于“自动识别同一句里的中英混写”。MyScript 配置文档给出 `lang` / `recognizer.lang` 单语言设置；未找到足以保证中文模型英文词汇覆盖的官方说明。须用简中、英文、`这个 API 的 timeout 是 30 ms`、专有名词、数字标点、换行、连续补笔分别验收；如果需要手动切换语言，应明确说明，不伪装为自动混写。

## 集成与验收边界

- 前端保持现有指针采样与即时墨迹，不等待识别。抬笔后把有界的笔画序列交给后台原生识别；连续落笔使过期结果失效。停顿时间通过原型实测，不能每抬一笔便拆成一个字。
- 只在专门的“手写文字”模式识别。普通画笔保留手写；规整图形独立开关，避免文字被变成图形。
- 笔迹与转换是可撤销编辑；识别未完成、失败、取消或退出时保留可恢复的原始笔迹。用户无需确认每次转换，点击文字时才提供更正入口。
- SDK 有自己的文档、撤销与渲染能力；此处只取识别结果映射到本项目编辑命令，避免第二套文档状态。
- 校验 SDK 总体积、语言资源体积、许可证、离线激活条件、最低系统版本。性能与准确率必须用真实中英文轨迹测量，不能引用营销材料作为本项目结果。
- MyScript 同时提供 Shape / Raw Content Recognizer，可另行评估图形规整，不把图形分类准确率推断为手写文字准确率。

## 一手来源

- [MyScript 平台矩阵](https://developer.myscript.com/docs/sdk/4.5/integration/platforms/)：macOS、C++、本机与 Web 的区别。
- [MyScript 识别器](https://developer.myscript.com/docs/sdk/4.5/recognition-capabilities/recognizers/)：增量文本、图形和 Raw Content 识别。
- [MyScript 语言](https://developer.myscript.com/docs/sdk/4.5/recognition-capabilities/text-languages/)：中文与英文支持。
- [MyScript 配置](https://developer.myscript.com/docs/sdk/4.5/reference/configuration/)：语言配置。
- [MyScript 接入层级](https://developer.myscript.com/docs/sdk/4.5/integration/integration-levels/)：C++ API 按需提供。
- [MyScript 定价](https://developer.myscript.com/pricing/)：本机开发测试 25 个许可，生产联系厂商签约；未确认 SDK 再分发细则。
- [MyScript Web 架构](https://developer.myscript.com/docs/cloud/4.5/overview/introduction/)：识别在服务器处理。
- [ML Kit Digital Ink](https://developers.google.com/ml-kit/vision/digital-ink-recognition)、[语言列表](https://developers.google.com/ml-kit/vision/digital-ink-recognition/base-models)。
- [Apple UIScribbleInteraction](https://developer.apple.com/documentation/uikit/uiscribbleinteraction)。
- [Chromium Handwriting API](https://developer.chrome.com/docs/web-platform/handwriting-recognition)。

## 向厂商申请的具体交付物

- MyScript iink SDK 4.5（或厂商建议当前版本）的 macOS arm64 / x64 C++ 发行包、头文件、库及最小识别示例。
- 本机开发测试许可、证书和离线／首次激活要求。用户已接受商业 SDK 方向，但尚未签约或购买，不能把偏好当成接受厂商合同。
- 简体中文、英文的识别资源；可选繁体中文。要求确认中文语境内拉丁单词、`API` 等缩写、数字标点的混写支持；若需双识别器，明确结果评分与分段方案。
- Text / Shape / Raw Content 增量识别接口在 macOS C++ 包里的可用性、线程限制、取消及过期结果处理方式。
- 最小包体积／语言资源体积、再分发许可、每设备计费、更新与离线许可有效性。

官方入口：[原生 SDK 开发者入口](https://developer.myscript.com/)、[联系厂商](https://developer.myscript.com/contact/)。本轮只读取公开资料，没有注册账号、接受合同、购买或向厂商发送消息。

## PaddleOCR 历史调研（路线已终止）

用户询问后追加，并已选择先做 PaddleOCR 本地原型。现已安装 SDK、下载固定校验和的官方模型；没有把笔迹发到外部服务。

- [官方文本识别模型文档](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/module_usage/text_recognition.en.md)明确说明 PP-OCRv5_rec 单模型支持简中、繁中、英文、日文，以及手写、竖排、拼音、生僻字。v5_mobile_rec 约 16MB，v5_server_rec 约 81MB，均为识别模型体积，不含检测、推理运行时与应用打包依赖。
- 当前[主仓库](https://github.com/PaddlePaddle/PaddleOCR)已列 PP-OCRv6 tiny / small / medium、单模型多语言和 Apple M4 测量信息；厂商基准不是本项目性能。对直接手写场景，v5 的手写支持描述更明确，应同 v6 一起用实际轨迹比较，不能只按版本号或通用 OCR 指标选型。
- 官方已有 [PaddleOCR.js 浏览器部署](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/inference_deployment/cross_platform/browser.md)，npm 包 `@paddleocr/paddleocr-js`，示例使用 PP-OCRv5；可直接输入 Canvas / ImageData，并支持独立 Worker、ONNX Runtime Web WASM 推理。本轮采用这条路径，避免打包 Python；WKWebView 合成样例已验证兼容，真实字迹延迟分布与内存仍待测量。默认示例从网络取模型与 WASM，离线交付需改为随应用打包的本地资源，不能在书写时依赖 CDN。多线程、WebGPU 的响应头条件及 module worker 构建须实测；单线程也应在独立 Worker 中运行，保护书写主线程。
- [官方 macOS 安装文档](https://www.paddlepaddle.org.cn/documentation/docs/en/install/pip/macos-pip_en.html)目前列 Apple Silicon arm64、CPU 推理，并注明不再支持 x86_64。Python 能运行不等于可直接打包为 Rust/Tauri 的双架构发行包，端内 ONNX / CoreML 等路线须单独验证模型算子与输出一致性。
- 仓库代码为 [Apache-2.0](https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE)，仍需核对最终选择的权重、字典及运行时的再分发许可。
- 可实现同样的“写 → 停顿 → 原位出文字”界面：应用自动按行／字组收集笔画并渲染白底高对比图，后台 OCR，过期结果丢弃，成功时可撤销替换，失败时保留墨迹。用户不必知道内部是图像 OCR，也不必先圈选。
- 技术差异：PaddleOCR 常规模型不直接利用笔顺和时间序列，不自带连续手写输入的分段、候选更新、补笔、跨行与撤销整合；这些由应用实现。不能据此武断认定它识别一定差，也不能未经实测承诺达到 Goodnotes 体验。
- 建议用同一组中、英、中英混写真实笔迹，对比字词准确率、首次加载、停笔至结果 p50 / p95、补笔后的稳定性、内存与最终包体积，再决定是否值得采购 MyScript。截图取字本身也适合由 PaddleOCR 承担，可复用其图像能力，但它不替代规范图形的几何识别。


## PaddleOCR 历史原型与实测（未通过用户验收）

- 固定依赖：PaddleOCR.js 0.4.2、OpenCV.js 4.10.0-release.1、ONNX Runtime Web 1.24.3。采用 PP-OCRv5 mobile det + rec ONNX，模型合计 20.5 MiB，WASM 约 11.8 MiB；首次显式下载并校验 SHA-256，之后构建与推理离线。模型卡 [识别](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec)、[检测](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det) 均标 Apache-2.0；相关许可证、NOTICE 随包保留。
- 主画布与覆盖层 W 模式共用。每笔先走原有编辑命令，抬笔 1.2 秒后自动识别；所有删除原笔迹与插入文字构成一个事务，撤销一次恢复原笔迹。普通画笔不识别；切工具取消待转换组。
- 后台 Worker 执行栅格化、OpenCV 与 ONNX。输入白底黑字，按较高笔画高度归一化，独立于显示器 DPR、主题与背景。原始笔迹继续保留其颜色／笔刷，转换文字使用当前画布默认排版。
- 所有笔迹在结果回来前需仍存在且未变；补笔、删除、移动、撤销及退出模式使旧结果失效。低置信度（本原型阈值 0.65，尚未校准）、空结果、检测框未覆盖整组笔迹、超时或故障保留原墨迹。阈值与覆盖检查是保守防丢策略，不保证识别文字正确。
- SDK 的默认 ImageData 入口依赖 DOM，不能直接在 Worker 中调用；原型用它支持的 OpenCV Mat 入口，显式释放临时 Mat。CSP 保持同源，只允许 WASM 编译，不开放联网识别或任意 JS eval。
- 测试环境：Apple M4、arm64、macOS 15.6.1 (24G90)，隔离 WKWebView、自定义应用协议、生产 Vite Worker、CPU WASM 单线程。本轮三组手工构造矢量轨迹输出 `HI`、`中文`、`中API30`；最后一组期望 `中 API 30`，字符匹配但空格丢失。三次推理约 86/54/58ms，仅为单次诊断，不含停顿与冷初始化，不代表真实用户手写准确率或延迟分布。固定放大 2× 曾导致本次中文检测漏字，归一化后恢复，验证了保留漏检笔迹的重要性。
- 19 项前端测试通过，覆盖连续落笔、旧结果丢弃、失败保留、漏笔覆盖、转换事务的一次撤销与重做。TypeScript / Vite 构建通过；独立 **Coboard Ink Preview.app** 约 84.42 MiB（debug 构建），已启动，与已有应用使用不同数据目录。
- 尚未验证：真实多人字迹与连笔、中英长句及空格、跨行排序、不同大小字混写、p50/p95、内存峰值、旧版 WebKit（需要 OffscreenCanvas / Worker / WASM SIMD）以及全部原生覆盖层交互。当前不自动合并已经转换的上一段；点击文字可更正，不要求每次确认。公式与截图 OCR 仍未实现。

复现：`npm run handwriting:download` 准备本地模型，`npm run build` 后编译 `scripts/verify-handwriting-webkit.swift`，传入 `dist` 和 `scripts/handwriting-fixtures.json`。该测试不操纵用户界面、不打开用户笔记；字符匹配与空格保真分别报告。`scripts/smoke-handwriting.mjs` 是额外的计算层英文合成样例，不替代 WebKit 集成测试。
