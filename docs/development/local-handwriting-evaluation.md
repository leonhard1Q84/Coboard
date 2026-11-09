# 免费本地手写替代：Goodnotes 调研与有界实验

用户约束：更换不可用的 PaddleOCR 直接书写原型，不接受 1.2 秒主动等待；坚持本地、免费。以下不是新引擎已接入的交付声明。选型状态见 [ADR-005](../decisions/ADR-005-incremental-digital-ink.md)。

## 目前可以确认什么

- 1.2 秒来自现有 `HandwritingSession` 的 `pauseMs = 1200`，等待结束后才识别；不是 PaddleOCR 纯推理耗时。缩短它可能提早拆开尚未完成的字，不能独立解决体验。
- `iinkJS` 官方 README 已宣布停止维护并推荐 `iinkTS`；两者都是连接 MyScript Cloud 的前端库，需要开发者密钥，不是开源的本机识别模型。`iinkTS` 提供 WebSocket 笔画增量接口，但不能满足本次本地要求。其当前源码还有默认 1000ms 导出等待和上层同步防抖，不能因为用了 WebSocket 就假定端到端无等待。
- Goodnotes 官方公开介绍自研设备端模型，但本轮没有找到可直接复用的生产模型或识别 SDK。
- 本机实测的 `hanzi_lookup` 可以低开销识别规范孤立汉字；没有验证自由整行、中英混写或真实多人字迹。系统 Vision 的现有三组样例均未正确识别，因此未接入替代版。

## Goodnotes：事实、推断与未知

官方文章 **Behind the Scenes: Shipping Handwriting Recognition** 正文日期为 **2023-06-01**，说明其在 **2022 年底**发布自研手写识别模型，之后手写搜索与转文字由自研技术驱动，并在设备端运行。文中描述约三年、十人的模型研发工作。页面结构化元数据与可见日期不一致，这里采用正文日期，只视为历史官方说明，不推断当前发行包的具体模型版本或网络结构。

当前官方拼写检查帮助同样说明设备端处理。Apple Scribble 在 Goodnotes 中是另一项功能，官方明确它独立于 Goodnotes 自研手写识别。标准“转文字”帮助描述的是套索圈选后转换，不能把 Goodnotes 识别效果推断为已达到 Coboard“自动原位直出”的延迟目标。

公开的 GoodNotes/GNHK-dataset 是带 CC-BY-4.0 许可的**英文手写图像数据集**，不是产品权重、中文数字笔画模型或即插即用的 SDK。官方研发文章没有公布训练权重、笔画分段算法、真实 p95 延迟或足以复现厂商准确率的数据集。本轮公开仓库搜索有分页限流边界，因此只说“本轮未找到可直接复用的生产引擎”，不声称证明不存在。

REA 范围：已读取用户指定的 REA 技能并执行只读 doctor。当前会话没有 REA MCP 工具；诊断显示注册缺失、当前 Node 不在支持版本范围且原生分析引擎未配置。`/Applications` 和 `~/Applications` 未发现 Goodnotes，没有可绑定的本机分析目标。未安装应用、未修改客户端配置、未附加进程、未读取用户笔记，也没有产生二进制分析 Evidence ID。以下 Goodnotes 结论来自公开一手资料，而非逆向或运行时观察。

## 系统 Vision：速度快，但这组识别结果不合格

环境：Apple M4、arm64、macOS 15.6.1 (24G90)、Swift 6.1.2，编译 `-O`；系统 `VNRecognizeTextRequest`，accurate，中英语言列表，关闭语言纠正。沿用仓库三组合成轨迹，白底黑字 2× 栅格化，并检查输出图片方向与形状正常。每组一次首调用加十次热态调用。原始结果见 [vision-observed.jsonl](../../research/handwriting/vision-observed.jsonl)。

| 合成输入 | 实际输出 | 该组首调用 ms | 热态 p50 / p95 ms |
| --- | --- | --- | --- |
| HI | -T | 7257.35 | 17.18 / 20.20 |
| 中文 | 空 | 15.13 | 14.55 / 17.02 |
| 中 API 30 | 口 API30 | 56.82 | 41.02 / 43.68 |

这是单次进程的有界诊断；只有第一组包含该进程首次使用系统识别的准备开销。热态数值仅是栅格图识别，不含 IPC、笔画分组、界面排版或显示时间，十次也不足以建立产品 p95。三个样例不是用户真实字迹，不据此泛化所有 Vision 准确率，但足以否定“直接切换本 API 就已解决当前样例”的交付说法。

## hanzi_lookup：规范单字能识别，整行混写尚不可替换

固定官方提交 `01f90c3ab99a8fadf0696c28e5eb097223c500db`。Rust/WASM，输入某一个汉字的各笔 XY 数组，返回汉字与排序分数；分数不是置信概率。内嵌 9,507 汉字，JS + WASM 共 **745,700 bytes**。代码 LGPL-3.0，字形笔画数据另有 Arphic Public License；本轮仅下载到 `/tmp` 验证，不向应用添加依赖或分发二进制。

环境：Apple M4、macOS 15.6.1 / Darwin 24.6.0、arm64、Node v25.6.1。本地加载及实例化一次 **8.43ms**，不含进程启动、下载，也未保证磁盘缓存为冷。运行时禁用 fetch。每个输入重复 100 次；既有“中文”样例按已知字间空隙**手动拆字**，不是自动切字。另在首次运行前固定两组规范四笔坐标作为阳性对照，没有从模型取样或反复调参。

| 单字输入 | Top 1 | Top 5 是否含目标 | 热态函数 p50 / p95 ms |
| --- | --- | --- | --- |
| 规范四笔中 | 中 | 是 | 0.0554 / 0.0745 |
| 规范四笔文 | 文 | 是 | 0.0183 / 0.0237 |
| 原型合成中，三笔非规范分组 | 巾 | 否 | 0.0403 / 0.0991 |
| 原型合成文，撇捺次序反向 | 卞 | 否 | 0.0188 / 0.0228 |

结果证明本地单字引擎确实能工作且开销低，也说明笔顺和分组有明显影响。不能将重复合成轨迹的函数时间宣称为真实书写、WKWebView 或产品端到端延迟。它不提供英文词模型、自动整行分字、连笔合并和中英混写。可作为“逐字候选输入”的实验底座；若保持原位自由书写，仍须验证分组和补笔，不能直接替换现有 W 模式。

Zinnia 也提供笔画序列到孤立字符候选的 C++ / C API，引擎为 New BSD，Tomoe 模型另为 LGPL-2.1。本轮只核实接口和许可，未在本机编译或测试，不能承诺更好的准确率或速度。Google ML Kit 官方 SDK 支持面向 Android / iOS 的离线数字墨迹，不是现有 macOS Tauri 的现成替换。

## 复现与当前交付边界

- [probe-vision.swift](../../research/handwriting/probe-vision.swift)：`swiftc -O -module-cache-path /tmp/coboard-vision-module-cache research/handwriting/probe-vision.swift -o /tmp/coboard-vision-probe` 后，以 `apps/coboard-desktop/scripts/handwriting-fixtures.json` 为参数运行。沙盒限制会造成系统 Vision 调用失败，不能将这种失败当识别结果；上表来自获准的本机运行。
- [probe-hanzi.mjs](../../research/handwriting/probe-hanzi.mjs)：`node research/handwriting/probe-hanzi.mjs /tmp/coboard-hanzi-probe /tmp/hanzi-replay.json`。必须先按 [hanzi-sources.json](../../research/handwriting/hanzi-sources.json) 准备官方固定提交的资源；脚本校验大小与 SHA-256，并在识别期间禁止 fetch。临时资源可能被系统清理，未复制模型或第三方代码进应用。
- [hanzi-observed.json](../../research/handwriting/hanzi-observed.json)：包含所有输入、候选、100 次原始计时、环境和来源哈希，保留成功和失败样例。

本轮只交付调研、可执行实验与原始测量记录；没有任何候选通过“免费本地 + 中英自由书写 + 低延迟 + 真实字迹准确率”完整验收。没有修改应用源码、移除用户笔迹、启动旧版冒充新版，也没有向云端发送笔画。下一步若用单字候选器，需要明确接受交互能力变化；若保持完整自由书写要求，则继续模型与分段研发，而不是承诺换库即可达成 Goodnotes 效果。

## 一手来源

- MyScript：[iinkJS README](https://github.com/MyScript/iinkJS)、[iinkTS README](https://github.com/MyScript/iinkTS)、[触发配置](https://github.com/MyScript/iinkTS/blob/master/src/canvas/CanvasTriggerConfiguration.ts)、[WebSocket 协议](https://github.com/MyScript/iinkTS/blob/master/architecture/websocket-protocol.md)。
- Goodnotes：[自研引擎研发文章](https://www.goodnotes.com/blog/machine-learning-engineer-handwriting-recognition)、[拼写检查](https://support.goodnotes.com/hc/en-us/articles/14500614035471-Spellcheck-your-handwriting)、[Apple Scribble 的区别](https://support.goodnotes.com/hc/en-us/articles/7353717663887-Use-Scribble-in-Goodnotes)、[转文字流程](https://support.goodnotes.com/hc/en-us/articles/7353695997199-Convert-handwriting-to-text)、[GNHK 数据集](https://github.com/GoodNotes/GNHK-dataset)。
- hanzi_lookup：[固定提交 README](https://github.com/gugray/hanzi_lookup/blob/01f90c3ab99a8fadf0696c28e5eb097223c500db/README.md)、[接口](https://github.com/gugray/hanzi_lookup/blob/01f90c3ab99a8fadf0696c28e5eb097223c500db/hanzi_lookup/src/lib.rs)、[代码许可](https://github.com/gugray/hanzi_lookup/blob/01f90c3ab99a8fadf0696c28e5eb097223c500db/LICENSE)、[数据许可](https://github.com/gugray/hanzi_lookup/blob/01f90c3ab99a8fadf0696c28e5eb097223c500db/LICENSE-APL)。旧 [HanziLookupJS](https://github.com/gugray/HanziLookupJS) 为不同项目，不能混用许可结论。
- [Zinnia 源码](https://github.com/taku910/zinnia)、[Tomoe 模型](https://github.com/taku910/zinnia/tree/master/zinnia-tomoe)、[ML Kit 平台说明](https://developers.google.com/ml-kit/vision/digital-ink-recognition)。
