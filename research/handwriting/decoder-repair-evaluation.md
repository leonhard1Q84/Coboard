# 手写解码修复回放（2026-11-09）

已实现多笔连写切分及候选排序修复；**整体识别仍未达到可用性验收门槛**。同一固定输入 SHA-256 `70bddc5f987b361971c21493d369fe837b04195d0be5778860001b0f8fd25727`，完整回放 5,764 个样本；未更换目标清单、删掉失败或向推理传标签。原基线保留在 [common-eval-baseline.md](common-eval-baseline.md)。本次已使用这些样本诊断与开发，不再称其为新的独立验收集。

| 分组 | Top-1 修复前 → 后 | Top-5 修复前 → 后 | 推理错误 | 最终请求计算 p95，ms |
| --- | ---: | ---: | ---: | ---: |
| composed-diagnostic/ambiguous | 19.11% → 38.04% | 33.57% → 57.86% | 0 → 0 | 109.23 → 103.23 |
| composed-diagnostic/english-word | 11.67% → 48.62% | 21.96% → 59.71% | 13 → 0 | 288.14 → 191.59 |
| composed-diagnostic/number-string | 27.19% → 42.19% | 57.19% → 65.00% | 0 → 0 | 23.10 → 22.04 |
| development-regression/chinese-phrase | 100.00% → 100.00% | 100.00% → 100.00% | 0 → 0 | 184.69 → 163.02 |
| development-regression/english-word | 100.00% → 100.00% | 100.00% → 100.00% | 0 → 0 | 244.76 → 153.21 |
| human-isolated/digit | 49.00% → 51.50% | 80.00% → 83.00% | 0 → 0 | 3.26 → 2.76 |
| human-isolated/lowercase | 41.83% → 56.63% | 74.33% → 87.31% | 18 → 0 | 110.03 → 7.13 |
| human-isolated/uppercase | 58.56% → 58.37% | 82.88% → 85.58% | 0 → 0 | 7.42 → 2.98 |

拼接英文首选含中文：378 → 20。重试错误 0，笔画身份错误 0；稳定前缀错误 57 → 4，仍只作可撤回建议，不能自动转换或删除墨迹。共有 1279 例从错误恢复首选，76 例出现新增首选失败；逐例保留于 [差异清单](decoder-repair-diff.json)，没有只报总分。

## 多笔连写与修改内容

- 同时支持跨多次抬笔的时间切分、空间切片和普通分笔字符组合。片段分类保留抬笔边界；只对精确同端点续笔合并工作路径，不画出不存在的连接线。时间/空间搜索各最多 25 切点、300 区间，两种脚本共享片段结果；多笔缓存键包含笔画边界。
- 宽组件允许竞争多字结果；擦边重叠交由外层 DP 比较，补充偏移/高置点画和断开的短横画吸附。单组件不再承受跨组件宽高比惩罚；圆形小写、多组件合并、大小写/脚本转移分别处理。
- 分笔英文复用既有词表前缀势函数，汉字使用既有 LM 的有界弱一元先验。保留孤立单字候选，不把词表当作生成缺失字母的工具。连写分数改为字形对数均值的指数加弱词频，仍是启发式排序，尚未跨脚本概率校准。
- 主相位概率 ≥0.85 时提前结束，其他情况保留四相位。九层卷积与池化数组复用容量，未新增依赖、网络、模型权重或文档格式。

从四条既有开发轨迹精确插入两次/三次 pen-down，8/8 个变体最终首选正确，全部逐笔追加并验证原 ID 和幂等重试。这些是同源的人工抬笔变体，**不冒充独立自然多笔准确率**。最慢最终请求 285.97ms，尚未全部满足 200ms 计算预算。非连续端点、多笔回勾、迟到点画分别由切片/笔画边界/会话测试覆盖其结构；仍需独立自然多笔语料检验实际识别效果。

## 验证与限制

本机 macOS/arm64，release、顺序 CPU、本地同一研究模型，固定竖线准备后回放；模型与源码哈希见 [环境记录](decoder-repair-environment.json)。文件系统缓存、温度及后台负载未控制；期间运行过短暂测试、构建与额外开发回放，时间只能作本机诊断，不能宣称严格提速倍数或端到端性能。p95 是最后一次请求的 Rust 计算时间，不含 IPC、前端排队和绘制；多笔累计时间保留在原始输出。

识别包 33 项测试（含本地模型显式回放）、评分器 7 项测试通过；全仓默认成员测试、fmt 和 all-targets Clippy 通过；前端 26 项测试与生产构建通过。本轮未做实际窗口、屏幕共享、转换撤销或端到端延迟复验。

“微笑”仍只有用户确认的截图，缺少原始笔迹，不能宣称该具体案例已修复。中文与自然英文词/多笔连写仍缺独立自然笔迹覆盖，大小写和孤立字符也仍低于质量门槛。评分器仍按未达标返回 1，没有降低门槛或把改进写成验收通过。

## 复现与证据

```sh
python3 research/handwriting/run-common-eval.py /private/tmp/coboard-human-ink/uji-test.json /tmp/coboard-repair-replay
python3 research/handwriting/generate-multipen-regressions.py /tmp/coboard-multipen.json
cargo run --offline --locked --release -p coboard-vision-ml --example common_eval -- /tmp/coboard-multipen.json
cargo test --offline --locked -p coboard-vision-ml -- --include-ignored
```

- [全量原始请求](decoder-repair-observed.jsonl.gz)、[汇总及全部失败](decoder-repair-summary.json)、[前后逐例差异](decoder-repair-diff.json)。
- [多笔变体逐笔请求](multipen-repair-observed.jsonl.gz)；生成器仅插入同端点抬笔，不上传用户内容。
