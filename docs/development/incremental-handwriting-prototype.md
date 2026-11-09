# 增量空间 DP 与原生手写后端（2026-11-09）

用户 memory / goal 被识别为其他字形或中文，随后“我们”又被误作 among。这说明只修英文连写不能解决中英混写。现已增加同笔中文字符切分、逐字上下文和中英文共用的区间推理缓存，保留原始墨迹和手动候选。四条真实轨迹及其 72 个变体的当前联合检查见 [中文连笔与英文竞争修复](../../research/handwriting/mixed-connected-evaluation.md)，其中包含完整证据、测量边界与尚未验收的能力。

较早 [goal / memory 修复](../../research/handwriting/goal-evaluation.md)、[memory 记录](../../research/handwriting/memory-evaluation.md) 和 [hello 基线](../../research/handwriting/connected-evaluation.md) 都保留为历史测量。原混写组合仍为 41/48；多人自由书写验收未完成，下文早期合成耗时不代表连笔或窗口延迟。

阶段 2 分段解码器和阶段 3 Tauri 后台接入已实现。`libochwpro` 的单字准确率未达标，因此桌面原型采用仓库已有的本地 Path-Signature + Sparse CNN 模型与二元语言模型。它在七组合成开发样例上全部正确，48 组组合变体通过 41 组；这不是自由手写准确率通过验收。决策见 [ADR-006](../decisions/ADR-006-spatial-dp-handwriting-prototype.md)，失败的 libochwpro 首轮数据见 [历史基线](ochwpro-handwriting-baseline.md)。

## 2026-11-09 真实输入复核

独立导入 UCI UJIpenchars2 全部 20 位测试书写者的 2,480 个字母数字样本，混合字符范围下单字 Top-1 仅 52.66%，Top-5 84.84%。该结果没有中文或整行分段，已经足以否定“合成回放正确便可交付”的判断。来源、固定抽样、全部预测与复现见 [真人评估](../../research/handwriting/human-evaluation.md)。本地模型及当前移植实现仍不满足产品可用性验收。

另修复 `normalize_box_strokes` 仅在 4 个采样点、固定 15 像素阈值下处理反向底横的缺陷：改用相对尺度与有界几何角点检测，仅改变送入模型的工作副本，保留各段全部采样点，原始文档和撤销单元不变。在同一七组轮廓的四种大小、三种采样密度共 84 个确定性回归输入中，整行首选由 57/84 提升到 84/84；原有 48 组组合仍为 41/48。这是采样一致性修复，不是真实手写准确率提升的证据。生成脚本为 `research/handwriting/generate-input-robustness.py`，原始前后记录与逐组汇总在同目录 `input-robustness-*`。

前端增加默认关闭的本地计时诊断，详见 [延迟测量说明](handwriting-latency-diagnostics.md)。尚未报告新窗口测量，不能把埋点已实现说成端到端延迟达标。

本轮全仓离线测试、格式、Clippy（包含桌面包）、显式本地模型回归通过；前端 26 项测试及构建通过。全仓测试需要本机回环端口，沙盒拒绝后在本机重跑通过。未重新启动用户窗口，未报告新版窗口端到端 p95。DLL 与 Rust 的有界静态核对见 [运算审计](../../research/handwriting/human-engine-static-audit.md)：已核对的卷积、池化及激活未发现确定移植错误，但特征、稀疏规则和逐层运行值尚未证明等价。

## 实现

- [incremental.rs](../../crates/coboard-vision-ml/src/incremental.rs)：空间包围盒组成分量；DP 枚举 `(j, i)` 笔画区间并缓存单字候选。追加、删除、移动和跨字补笔只失效受影响后缀；结果携带原始笔画索引。
- 修正按字符数相乘概率导致的跨字合并偏置，按空间分量数加权对数概率；加入宽高比惩罚、中英／大小写／数字转移先验、空间空格与中文二元上下文。没有按目标字符串特判；所有系数均经开发集调试，不能视为盲测。
- 原生单字推理按四个子栅格相位加权（0.7 / 0.1 / 0.1 / 0.1），减小稀疏卷积池化对栅格位置的敏感性；对浮点栅格整数边界做微小数值吸附。未启用 Accelerate，没有新增模型运行时依赖或前端 OpenCV/WASM。
- [recognition.rs](../../crates/coboard-vision-ml/src/recognition.rs)：模型按需加载、每窗口一个会话、会话序号校验、后缀替换、重复请求幂等处理；最多八个窗口、每行 128 笔／32,768 点，每字符最多 32 笔。错误不推进会话，保留笔迹。
- Tauri 使用单并发信号量与 `spawn_blocking`；抬笔后通过 IPC 发送会话、序号、笔画 ID 和变化后缀，Channel 返回候选、稳定范围和计算时间。前端最多一个在途请求，后续抬笔合并为最新待处理快照；没有停笔等待定时器，10 秒仅为故障超时。
- 前端废弃过期结果；取消、补笔、移动、删除、撤销和关闭识别开关均使候选重新校验。点击转换前再次逐点核对笔迹；删除笔迹与插入文字是一个编辑事务，撤销一次恢复原笔迹。失败清理当前识别组，下次抬笔可重新开始。
- 稳定范围是可撤回建议，最后一字始终不标稳定；不会据此自动删除笔迹。当前候选入口需点击确认，自动直出仍需真实字迹和稳定策略验收。指针到墨迹完全在前端，模型加载、IPC 与保存都不阻塞书写。

## 测量条件与结果

MacBook Air / Apple M4 / 16 GB、arm64、macOS 15.6.1 (24G90)、Rust 1.98.0，release 原生 CPU。模型加载本轮约 11.98 ms，磁盘缓存未受控，不称进程冷启动。每组先预热一轮，独立会话回放 30 轮，共 1,830 次热态逐笔更新；每轮重新建立缓存，统计包含每行开头的推理。

| 合成样例 | 最终首选 | 正确回放 | 更新 p50 / p95 ms |
| --- | --- | ---: | ---: |
| HI | HI | 30/30 | 6.45 / 7.30 |
| 中文（旧三笔中） | 中文 | 30/30 | 3.51 / 3.90 |
| 中 API 30 | 中 API 30 | 30/30 | 7.11 / 8.10 |
| HI，H 横画最后补 | HI | 30/30 | 6.65 / 11.14 |
| 中 API 30，A 横画最后补 | 中 API 30 | 30/30 | 7.29 / 30.71 |
| 明天，八笔明 | 明天 | 30/30 | 3.72 / 8.33 |
| 中文，规范四笔中 | 中文 | 30/30 | 3.50 / 4.19 |

最大单次计算约 31.70 ms；这些时间含空间分组、缓存维护、四相位推理、DP 和稳定建议，**不含 IPC 排队、序列化、前端渲染或设备采样，未测出抬笔到候选显示的端到端 p95**。慢写样例每笔逻辑间隔 2,000 ms，回放不实际等待，验证的是算法不依赖停顿提交。重复同一输入用于性能统计，不是 30 人准确率。

原生模型原始相位单字 Top-1 为 17/22 个字符出现位置，Top-10 为 22/22；该单字诊断不包含四相位和上下文。48 个额外样例使用同一组字形构成 24 种字符串，并施加两组缩放／错切／平移；每组预热一次、回放三次，41/48（85.4%）完全匹配。失败包括“中”→“巾”、`PA`→`pa`。它们也是参与开发的组合样例，不能证明新字迹泛化。相交字符、连笔、多行、长句、标点与真实多人字迹尚未验收。

原始证据：[七组逐笔记录](../../research/handwriting/native-incremental-observed.jsonl.gz)、[七组汇总](../../research/handwriting/native-incremental-summary.json)、[48 组记录](../../research/handwriting/native-composition-observed.jsonl.gz)、[48 组汇总](../../research/handwriting/native-composition-summary.json)。压缩记录保留 trial=0 的预热，汇总器排除该轮；汇总附输入与解压 JSONL 的 SHA-256。

## 本地模型与运行

模型沿用既有本机研究资产，不打包进仓库或应用，也不执行 DLL 代码：Rust 只解析权重和标签数据。训练权重的再分发许可尚未澄清，当前属于本地实验，不能据代码可运行认定可发布。模型目录需含：

| 文件 | bytes | SHA-256 |
| --- | ---: | --- |
| singleEngine.dll | 3,950,080 | 3908e7d0beb65dcaed238f256540937e3347bbe7a6c13d26a118a727e63cb57f |
| lm_HW_PB_7000_kn.arpa.7e9.prune.1e-7.lm.fixed | 2,033,252 | f20a2428aa867eff1b92b373fdb2ae28cf298544b6c85253f5a81b98f2cec054 |

通过 `COBOARD_HWR_MODEL_DIR` 指定目录；本机保留原有开发目录回退，其他机器需显式配置。缺失时画布照常启动、书写和保存，识别提示失败并保留墨迹。没有联网推理或上传笔迹。

```sh
# 仓库根目录。此处替换为已有的本地模型目录。
export COBOARD_HWR_MODEL_DIR=/path/to/local/handinput
npm run dev       # 完整 Tauri 桌面；修复根目录原先缺 package.json 的 ENOENT
npm run dev:web   # 仅 Web 画布，不能单独验证原生识别

cargo run --offline --locked --release -p coboard-vision-ml \
  --example incremental_probe -- research/handwriting/incremental-fixtures.json 30 \
  > /tmp/native-incremental.jsonl
python3 research/handwriting/summarize-incremental.py /tmp/native-incremental.jsonl
cargo run --offline --locked --release -p coboard-vision-ml \
  --example incremental_probe -- research/handwriting/composition-fixtures.json 3 \
  > /tmp/native-composition.jsonl
cargo test --offline --locked -p coboard-vision-ml native_model_replays_development_lines -- --ignored
```

应用中点击画笔打开笔刷面板，开启“手写识别文字”；连续单行书写，抬笔刷新候选，点击所需文字转换。“保留笔迹”结束本组；`⌘Z` 撤销转换。切到新行前先结束当前组，当前不支持自动跨行。

## 工程与窗口验证

全仓 `cargo test --offline --locked`、格式和 Clippy（包含桌面包）通过；前端 23 项测试、类型检查与 Vite 构建通过。显式开启的本机模型回归验证七组最终结果以及增量与完整重算一致。测试覆盖补笔与缓存、序号、失败恢复、取消／在途结果竞争、后缀合并、输入点快照和笔画 ID 校验。

独立 Coboard Ink Preview.app 已构建、签名验证并启动，主应用未重启。实际 WKWebView 中验证了抬笔后候选显示、选择 I 转换、一次撤销恢复原笔迹；用户随后继续操作窗口，因此停止追加撤销，保留窗口当前内容。UI 自动化拖动实际只产生短笔迹，因此这个冒烟检查只证明 IPC／候选／转换／撤销链路，不作为 HI 或中文真实手写准确率证据，也没有估算可见延迟。缺模型、跨行、补笔的大量输入仍以确定性测试与回放为主。

首次全仓测试在沙盒内因 loopback 绑定被拒失败；在本机重跑通过。没有以后台计算时间替代窗口端到端测量。
