# MyScript macOS 原生 SDK 申请稿

状态：备用本地草稿，未发送。用户进一步选择免费本地路线，本申请已暂停，不作为继续验证的前置条件。2026-11-08。

目的：取得 Coboard 的增量手写识别验证所需材料。不得把官方 Web / 云端 SDK 当作 macOS 本机 SDK。收到回复后再确定具体 SDK 版本、许可、包体积和实现接口，见 [ADR-005](../decisions/ADR-005-incremental-digital-ink.md)。

## 可发送正文

Subject: Request for macOS native iink C++ SDK — offline incremental Chinese and English handwriting

Hello MyScript team,

We are developing Coboard, a macOS desktop tool for writing and explaining content during screen sharing. It uses Tauri v2, a React/TypeScript canvas and a Rust application core. We would like to evaluate your native iink C++ SDK for local, offline incremental handwriting recognition.

We capture pen/mouse strokes as coordinates, timing and stroke boundaries. Our application owns ink rendering, document state, persistence and undo/redo. We need recognition results that can update as more strokes are added, without requiring the user to select an image or confirm each conversion.

Could you provide or explain how to obtain:

- The macOS arm64 SDK, C++ headers, native libraries, API documentation and a minimal incremental text recognition sample. An x64 package would also help compatibility testing.
- Simplified Chinese and English recognition resources and a development evaluation license, including first activation, offline use and expiration requirements.
- Confirmation of Chinese text mixed with Latin words, technical abbreviations such as API, numbers and punctuation. Please explain whether one recognizer supports this or language switching is required.
- The relevant APIs for stroke streaming, candidate updates, adding strokes to existing words, line segmentation, stable recognition results, cancellation and resource cleanup, including threading requirements.
- Minimum supported macOS version, native library and language resource sizes, and code signing / notarization requirements.
- Production licensing and redistribution terms, including device limits, recurring fees and update rights.

Our acceptance test will measure the complete path from the final pen-up to visible candidates and stable typeset text. Our evaluation targets are warm candidate feedback at p95 ≤ 200ms and stable conversion at p95 ≤ 300ms, with real Chinese, English and mixed-language stroke samples. These are application targets to validate, not assumptions about SDK performance. Please let us know whether the proposed integration is suitable and whether you recommend a different native integration approach.

Thank you.

## 回包检查

收到包后先确认架构、许可与中文资源，离线回放真实笔画并测量完整延迟，再决定是否进入 Tauri 集成；没有实际测量前不向用户承诺延迟和准确率。SDK 许可及证书等敏感材料不写入仓库，凭据按项目隐私规范处理。
