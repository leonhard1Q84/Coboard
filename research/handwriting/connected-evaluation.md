# 英文单笔连写修复与回归（2026-11-09）

后续 memory、goal 及“我们”暴露了新的实际失败；当前联合修订见 [中文连笔与英文竞争修复](mixed-connected-evaluation.md)。本页保留较早的 hello 基线。当前固定轨迹已有四条，变体生成器会生成 76 组；以下旧证据仍对应原来的 19 组。

用户的 `hello` 是一条 148 点连续笔迹。原分段器只能以原始笔画边界作为字界，整词被当作一个字；随后还会过滤多字符候选。截图显示“远”，当前旧混合单字链路在同形原始 XY 回放中首选为“毗”；两者都没有识别出单词。这里的前后比较以保存的逐次回放记录为准。

现在 `HandwritingRecognizer`（桌面 IPC 使用的同一 Rust 会话）调用 `recognize_incremental_segment`：保留原混合单字路径，并在符合几何条件的一条连续轨迹内建立虚拟字界。弧长切点补充有显著起伏的基线转折，总计最多 25 个切点、300 个可选区间；对几何可行且有词表前缀路径的区间全部搜索，避免推理预算只花在最短碎片上。每字调用本地分类器，beam 为 256，最多输出五个小写单词。对过宽字形、吞掉多个升部和小写字母异常高度施加几何惩罚；扣除几何惩罚后的字形几何均分低于 0.10 时拒绝单词候选。词频只能对有逐字形状证据的路径排序，不能添加分类器未提供的字母。这个阈值是开发期启发式，不能保证所有涂画均会被拒绝。

虚拟切点不改变文档、原笔画 ID、点序或撤销单元。单词与单字候选共同参加空间 DP；稳定前缀按完整 segment 计算，不能只截取单词首字母。原始笔迹变化后缓存失效；幂等重试返回同一结果。原有前端选择候选、原子编辑与撤销逻辑继续使用。

## 实测

使用本机 Apple M4 / 16 GB / macOS 15.6.1、arm64、release CPU、离线现有模型，顺序推理。先用固定竖线准备模型；每组保留 trial=0，随后运行 30 次新会话，耗时包含 Rust 会话校验、解码与返回值构建，不含 IPC、前端排队、真实指针事件、显示。模型准备的文件系统缓存未控制，不称冷启动。

- 原始笔迹：首选 `hello`，30/30；p50 **125.99 ms**，p95 **130.42 ms**；trial=0 为 136.35 ms。
- 同一轨迹的 3 个尺度 × 3 个错切 × 2 个采样密度变体：18/18，各 30 次首选均为 `hello`。连同原样例共 19 组。它们是参与开发的同一笔迹回归，不是 19 位书写者，也不是独立泛化准确率。
- 各组热态 p95 为 120.32–209.16 ms；最慢组超过 200 ms 的纯计算目标，不能称全部满足延迟预算。原始例的数字也不能替代抬笔至候选呈现的端到端 p95。
- 原 48 组合成混写回放仍为 **41/48**，失败项目与此前一致；旧七组合成样例的显式本地模型回归通过。没有将连写分支的改善写作中文或真人单字准确率改善。

原始用户笔迹在 `connected-fixtures.json`，只保留该轨迹，没有周围文档。完整 589 次会话回放（19×31）及其重试结果在 `connected-observed.jsonl.gz`；`connected-summary.json` 排除每组 trial=0 后汇总 570 次。原 48 组比较另见 `connected-composition-*`。每次重试验证了整个响应逐字段一致，重试计时不当作新一次推理。`classifier_calls` 仍表示空间区间分类回调次数，不是底层 CNN 前向次数；单词区间内部最多另有 300 次单相位前向。

## 来源与复现

内置 27,975 条英文词频数据，368,542 字节（含嵌入的完整来源声明），由 Robyn Speer 的 wordfreq 3.2 `small_en.msgpack.gz` 派生，固定提交 `912caf64b657478d1dff1138efdc078947d54bb1`。源文件 SHA-256：`f94a80cba6a3857b260d0666b5432bb7ea9b85315574dee9c306e87f61298247`。数据许可为 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)，原署名、数据来源与变更说明同时保存在 `english-lexicon.txt` 和 `wordfreq-NOTICE.md`；注释随 `include_str!` 嵌入引擎。词表构建脚本仅用 Python 标准库，不新增运行时依赖，不上传笔迹。

[固定上游目录](https://github.com/rspeer/wordfreq/tree/912caf64b657478d1dff1138efdc078947d54bb1)。本轮使用上轮已下载的固定文件、README 和 NOTICE 核对并校验哈希，没有再次访问用户登录站点。

```sh
python3 research/handwriting/build-english-lexicon.py /tmp/small_en.msgpack.gz /tmp/english-lexicon.txt
cmp /tmp/english-lexicon.txt crates/coboard-vision-ml/data/english-lexicon.txt
python3 research/handwriting/generate-connected-variants.py /tmp/connected-variants.json
cargo run --offline --locked --release -p coboard-vision-ml --example connected_probe -- /tmp/connected-variants.json 30 > /tmp/connected.jsonl
python3 research/handwriting/summarize-connected.py /tmp/connected.jsonl
cargo test --offline --locked -p coboard-vision-ml -- --ignored
```

## 界限与验证

该分支仅针对一笔连续的小写英文轨迹，目前至少 24 个采样点，输出 3–20 个字母的词表内单词。大写、词表外姓名、任意多笔连写、迟到的 i 点和 t 横、多人自然英文长句仍未完成验收；它们仍可落回现有混合单字路径。真人 UJI 单字 Top-1 52.66% 的既有结论不变。该模型训练集未知、分发许可未确认，仍是使用本机已有资产的原型。

全 workspace 离线测试通过；最后改动后领域识别包 18 项普通测试、2 项显式本地模型测试通过；全 workspace/all-targets Clippy 与 fmt 通过；前端 26 项测试、类型检查与构建通过。新增测试覆盖有限工作量、无形状证据时拒绝词表补全、字母证据约束、升部停笔重复点、坏坐标、缓存失效、完整单词稳定前缀和原始笔画身份。

构建了独立 `Coboard English Test.app`（debug，识别 crate opt-level=3），codesign 完整包校验通过，并发起启动。独立数据目录仅含用于验证的 hello；两个原有画布继续运行。未完成新版窗口中候选显示、转换、撤销的目视验证，也未测出端到端 p95。选中测试笔迹后使用“识别为文字”即可检查实际链路；本报告不把原生会话回放冒充窗口验证。
