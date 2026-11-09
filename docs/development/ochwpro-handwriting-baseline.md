# libochwpro 首轮实验历史基线（2026-11-09）

本文件保存首轮 libochwpro 失败结果及当时状态；后续已改用现有原生模型并接入桌面，见 [当前报告](incremental-handwriting-prototype.md)。首轮阶段 2 已有可执行原型，libochwpro 阶段 1 的单字准确率未达标，当时阶段 3 尚未接入桌面。不能将本报告的低计算耗时视为完成替换。选型和接入门槛见 [ADR-006](../decisions/ADR-006-spatial-dp-handwriting-prototype.md)。

## 实现与边界

- [分段器](../../crates/coboard-vision-ml/src/incremental.rs)：跨更新的 `(j, i)` 单字打分缓存、包围盒硬约束和内部空隙惩罚、脚本转移先验、空格推断、有界 beam 搜索、原始笔画索引和可撤回稳定范围。
- 补笔可改变空间分量，先前缓存的受影响后缀会失效；删除、替换同样处理。分类失败不推进已接受输入，保留原笔迹；输入为最多 128 笔、32,768 点，每个字符最多 32 笔。多行暂返回显式错误。紧贴、交叠的相邻字符可能被分量合并，属于当前限制。
- 没有候选自动提交、流式 Tauri IPC、Apple Accelerate 或真实窗口延迟测量。现有桌面入口仍使用原先的 Rust 引擎。新分段器没有进入指针到墨迹路径。
- 分类器适配器比较稀疏原始点与按弧长约每 8 坐标单位插值、每字最多约 480 点的输入；每笔至少两点，均不使用目标标签。该诊断预处理是在看到原始点误识别后加入的，所有样例都是开发集，不能作为盲测。
- 空间间隙惩罚也在观察首轮 HI 被合并成单个汉字后加入；最终指标是开发迭代结果，须用独立字迹验证。中英文上下文目前只是脚本类别转移先验，没有词典或训练好的字词语言模型。

## 条件与测量范围

MacBook Air / Apple M4 / 16 GB、arm64、macOS 15.6.1 (24G90)、Rust 1.98.0，release 构建。上游固定提交 `54c326d33d86cc0754dbea5a36c1448682c8202c`，Candle 0.9.2 CPU，未启用 Accelerate。本地权重及标签的 SHA-256 与该提交中的 `ochw-wasm/` 文件一致：

| 文件 | bytes | SHA-256 |
| --- | ---: | --- |
| ochw_model_fp16.safetensors | 3,451,280 | e6a3a92b4bed9ad7405b840506d5ae30f80f9a57723b20069f517d6b10f493e8 |
| char_index.json | 51,317 | 171cf2ac23731428ac9dd28f64be82dece5f66a0ca3d674ffb3b567b51532176 |

七组固定合成轨迹，每组先完整预热一轮，再独立建立会话回放 30 轮；每轮均重新生成缓存，所以统计包括每行开头缓存未建立时的计算。共 1,830 次热态逐笔更新。计时包括空间分组、缓存维护、必要的预处理与模型推理、DP 与稳定建议；不包括文件读取、IPC 排队、序列化、前端渲染和输入设备采样。加载权重约 6.12 ms，磁盘缓存未受控，不能称为进程冷启动。

## 结果

原始点单字 Top-1 为 **6/22 个字符出现位置**；插值后为 **9/22**，Top-10 分别为 15/22、18/22。这些位置包含重复字形，不是 22 个独立书写样本。规范四笔“中”插值后首选“申”，目标“中”排第三；原型三笔“中”首选“巾”。单字底座没有通过必要的正确性门槛，分段器无法恢复候选里缺失的字符。

| 合成样例 | 最终首选 | 完全匹配 | 每次更新 p50 / p95 ms | 更新数 |
| --- | --- | --- | ---: | ---: |
| HI | HI | 30/30 回放 | 2.25 / 4.59 | 180 |
| 中文（旧三笔中字） | 巾亢 | 0/30 | 2.02 / 2.92 | 210 |
| 中 API 30 | 巾 …I 孔 | 0/30 | 4.06 / 5.55 | 330 |
| HI，H 横画延迟到 I 后补 | HI | 30/30 | 3.24 / 6.80 | 180 |
| 中 API 30，A 横画最后补 | 巾 …I 孔 | 0/30 | 4.15 / 17.86 | 330 |
| 明天，八笔“明”后接“天” | 明天 | 30/30 | 2.36 / 5.97 | 360 |
| 中文，规范四笔中 | 申文 | 0/30 | 1.96 / 2.66 | 240 |

七组中三组完全匹配。30 次是重复同一输入用于测量，不是 30 人样本或可泛化准确率；旧三组合成整行只有 HI 完全正确。最慢一组热态 p95 17.86 ms，全部更新最大约 27.04 ms，低于 200 ms 计算目标；**没有测出抬笔到候选显示的端到端 p95**。没有 decode error 不代表没有识别错误。

补笔组固定两种跨字补横画顺序；慢写样例记录每笔间隔 2,000 ms 的逻辑时间戳，分类器不采用超时提交。回放没有实际等待这些间隔，也没有物理笔设备输入，因此证明的是算法不依赖停笔计时器，不是实际慢写用户验收。没有真实多人字迹、跨行识别、内存峰值和正式应用包体测量。

## 复现

从上游固定提交准备上表两个模型文件到一个本地目录，校验哈希。第一次 Cargo 构建需要获取公开依赖；之后使用 lockfile 离线运行：

```sh
# 仓库根目录；替换为已准备的模型目录
COBOARD_OCHW_MODEL_DIR=/tmp/ochwpro
cargo run --locked --offline --release \
  --manifest-path research/handwriting/ochwpro-probe/Cargo.toml -- \
  "$COBOARD_OCHW_MODEL_DIR" research/handwriting/incremental-fixtures.json 30 \
  > /tmp/coboard-incremental-observed.jsonl
python3 research/handwriting/summarize-incremental.py \
  /tmp/coboard-incremental-observed.jsonl

cargo test --locked -p coboard-vision-ml
cargo clippy --locked -p coboard-vision-ml --all-targets -- -D warnings
```

默认实验构建缓存位于独立 workspace 的 `target/`；本轮为复用编译产物设置了 `CARGO_TARGET_DIR=/tmp/coboard-ochwpro-probe/target`、`CARGO_BUILD_JOBS=2` 和 `MACOSX_DEPLOYMENT_TARGET=15.0`。性能时间来自 release 二进制，不含编译。

输入见 [incremental-fixtures.json](../../research/handwriting/incremental-fixtures.json)，逐笔候选、分段与原始时间见 [压缩 JSONL](../../research/handwriting/ochwpro-incremental-observed.jsonl.gz)，统计见 [summary.json](../../research/handwriting/ochwpro-incremental-summary.json)。汇总器可直接读取压缩记录。模型未打包进仓库，实验运行不上传笔画。

下一步应先用独立采集的中文、英文和混写轨迹验证预处理，再决定微调或更换单字模型；在此之前不把新模型切入 UI。通过底座门槛后，才按 ADR-006 的会话与序号协议接入后台队列，并在实际 Tauri 窗口测量候选显示和稳定转换延迟。

## 工程验证

`cargo test --locked`、`cargo fmt --all -- --check`、`cargo clippy --locked --all-targets -- -D warnings` 均通过。新增六项确定性测试覆盖缓存复用、替换与删除失效、跨字补横画、慢写多笔画、失败恢复、无效输入、多行拒绝、混写空格、稳定范围撤回，以及增量与全新解码一致性。独立实验 crate 的 release Clippy 和格式检查通过。

首次沙盒内全仓测试因媒体网关无法绑定 loopback 端口失败；获准在本机重跑后通过，未修改网关代码。编译期间因磁盘不足清理了可重建的桌面包构建缓存，未删除源文件或用户文档。没有启动新桌面预览，也没有以后台计算时间冒充窗口实测。
