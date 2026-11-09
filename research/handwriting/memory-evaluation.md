# memory 实际连写修复（2026-11-09）

本页保留 memory 阶段的历史测量。后续 goal 反馈引出的共同修订、三条轨迹联合回归与最终窗口验证见 [goal 修复记录](goal-evaluation.md)，以下耗时不冒充当前版本结果。

用户截图中的单词是 `memory`。从独立英文测试版已保存文档的只读 SQLite 备份恢复出与截图一致的 312 点单笔轨迹，只将这一笔加入回归，不导出周边文档。修复前，通过桌面使用的同一 Rust 识别会话回放，首选为 `ꎰ`，没有任何单词候选；因此此前七组合成样例正确、41/48 组合变体正确和 3.90–30.71 ms 计算 p95 均不能说明此类英文连写可用。

## 修复

`connected.rs` 原来以每个字母结束位置应向右推进作为硬约束，末尾 `y` 向左回勾时合法路径会被排除。窄印刷体比例约束又过度惩罚带长连接线的椭圆 `e/o`。现在仅允许具有右侧字形主体的末尾 `g/j/y` 回勾，并分别约束圆形字母、窄字母与末尾下伸部的宽高比。

最终仍使用原有 25 切点、最多 300 条区间和 256 beam 的搜索预算；没有增加词表、没有按 `memory` 或 `hello` 特判，没有添加运行时依赖。词表中的 memory 已在本轮修复前存在。候选必须有逐字形状证据，原有几何均分拒绝门槛和字母前缀约束保留。所有调整来自这份样本的开发调试，不能称独立盲测。

## 原始证据与测量

Apple M4 / 16 GB / arm64 / macOS 15.6.1，release 原生 CPU；模型、词表及来源沿用 [连写基线](connected-evaluation.md)。每组先保留一次 trial=0，随后 30 次新会话；计时含 Rust 会话校验、分段与候选构建，不含 IPC、前端排队或显示。模型准备的磁盘缓存未控制，不称冷启动。

| 实际原笔迹 | 最终首选 | 正确回放 | p50 / p95 ms |
| --- | --- | ---: | ---: |
| memory，312 点 | memory | 30/30 | 94.25 / 119.55 |
| hello，148 点 | hello | 30/30 | 127.79 / 130.41 |

各轨迹另外做 3 种尺度 × 3 种错切 × 2 种采样密度的确定性变换，连同两份原样例共 38 组，均为 30/30 首选正确。各组 p95 为 90.39–161.68 ms。它们只源于两份用户笔迹，既不是 38 位书写者，也不是 38 个独立单词，不能推广为自由书写准确率或显示延迟达标。

- [原笔迹](connected-fixtures.json)：此阶段使用 hello 与 memory（文件后续另增 goal），两者均保持原始点序，转换仍对应原笔画 ID。
- [修复前记录](memory-before-observed.jsonl.gz)：实际旧版会话回放，保留当时所有候选。
- [修复后完整记录](memory-after-observed.jsonl.gz)：38×31 次会话与每次幂等重试；保留预热。
- [汇总](memory-summary.json)：排除每组 trial=0，附输入与未压缩记录哈希。`baseline_top1` 表示单字旧路径，不是旧连写器的独立计时；真正修复前结果以上述 before 文件为准。

```sh
python3 research/handwriting/generate-connected-variants.py /tmp/connected-variants.json
cargo run --offline --locked --release -p coboard-vision-ml \
  --example connected_probe -- /tmp/connected-variants.json 30 > /tmp/memory-after.jsonl
python3 research/handwriting/summarize-connected.py /tmp/memory-after.jsonl
cargo test --offline --locked -p coboard-vision-ml -- --ignored
```

本轮仅改连写几何；原七组合成开发样例的显式模型回归通过。18 项普通识别测试与 2 项显式模型回归通过，后者现在同时验证两份原笔迹的桌面会话、笔画身份与幂等重试。词表外名称、多笔连写、迟到补笔、长句、多人自然手写仍不保证；既有真人单字 52.66% 的结论不变。本机研究模型分发许可未确认，仍未打包。

## 窗口验证

独立验证版使用 `app.coboard.memory-check` 数据目录，只放入这份 memory 笔迹的等比缩放副本；现有应用未退出、原文档未替换。后续用户在该窗口继续写入 goal；保留整个画布，并在 goal 修复记录中报告最终版本的可见候选验证。
