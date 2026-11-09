# 独立真人笔迹：UJIpenchars2 单字评估（2026-11-09）

此前七组合成样例和 48 组变体不构成真实手写准确率证据。本轮实际下载并评估了 UCI 官方 UJI Pen Characters (Version 2) 的测试书写者数据。

来源：[UCI 官方页](https://archive.ics.uci.edu/dataset/177/uji+pen+characters+version+2)，DOI `10.24432/C5FG8S`。作者：F. Prat、M. J. Castro、D. Llorens、A. Marzal、J. M. Vilar。官方页面标注 CC BY 4.0。原始语料共 60 位书写者、11,640 个孤立字符；本轮固定使用全部 20 位 `tst` 书写者的 ASCII 字母与数字，每字两次，共 2,480 样本。没有选择容易识别的字或书写者，没有根据结果调整数据、标签或识别参数。

保留原始整数 XY、重复点与抬笔边界；原始坐标原点在采集框左上，Y 向下。只用引擎原有预处理，识别使用桌面部署的混合字符范围与四相位 `recognize_incremental_glyph`，未用真实标签筛候选，也未用语言模型。标签只在推理之后计算分数。

| 类别 | 样本 | Top-1 | Top-5 | Top-10 |
| --- | ---: | ---: | ---: | ---: |
| 全部 | 2,480 | 1,306（52.66%） | 2,104（84.84%） | 2,224（89.68%） |
| 数字 | 400 | 176（44.00%） | 321（80.25%） | 345（86.25%） |
| 大写字母 | 1,040 | 561（53.94%） | 882（84.81%） | 931（89.52%） |
| 小写字母 | 1,040 | 569（54.71%） | 901（86.63%） | 948（91.15%） |

采样一致性修复前后的独立对照各跑完整 2,480 样本，首选预测逐项完全相同（均为 1,306/2,480），没有观察到首选回归或真人准确率提升。修复前记录为 `human-uji-before-normalization.jsonl.gz`；这也说明不能把几何回归集的改善写作真人准确率改善。

严格区分大小写的单字 CER 为 47.34%，推理失败 0；仅用于诊断的大小写折叠 Top-1 为 1,622 / 2,480（65.40%），不替代主要指标。常见混淆包括 `W/w`、`Y/y`、`P/p`、`0/O/o`、`3/了` 与 `f/扌`。逐书写者结果及全部混淆见 `human-uji-summary.json`。这组实测直接说明现有引擎不能以合成样例表现声称可用。

测量为本机 arm64 release 原生 CPU，单进程顺序推理；预热使用固定竖线，不依赖样本标签。模型加载 10.26 ms（文件系统缓存未控制，不称进程冷启动），单字计算 p50 3.85 ms / p95 4.34 ms。时间不含 IPC、排队、设备输入与显示。运行条件沿用项目本机 Apple M4 / 16 GB / macOS 15.6.1；不以快计算掩盖准确率不足。

边界：UJIpenchars2 是真实手写的孤立拉丁字符与数字，没有中文，没有自由整行分段，也没有本应用鼠标采样和 UI 端到端验证。数据集由本项目本轮独立导入，没有作为本项目调参集，但专有模型训练数据未知，无法保证模型从未接触 UJI。

原始 ZIP 保存在 `/private/tmp/coboard-human-ink/ujipenchars2.zip`，转换样本在同目录 `uji-test.json`。原始数据未加入应用包；仓库只保存导入脚本、来源清单、逐样本预测和汇总。校验和见 `human-uji-manifest.json`，原始 ZIP SHA-256 为 `0881b522911b99d9922820289441b50fd3d307f71cd7f9cc70e86872424a5f90`。

复现：

```sh
curl -L --fail 'https://archive.ics.uci.edu/static/public/177/uji+pen+characters+version+2.zip' -o /tmp/ujipenchars2.zip
python3 research/handwriting/human-import-uji.py /tmp/ujipenchars2.zip /tmp/uji-test.json
cargo run --offline --locked --release -p coboard-vision-ml --example human_probe -- /tmp/uji-test.json > /tmp/uji-observed.jsonl
python3 research/handwriting/human-summarize.py /tmp/uji-observed.jsonl > /tmp/uji-summary.json
```

使用本机既有模型，未联网推理或上传笔迹；未申请许可证、注册账号或联系数据作者。
