# coboard-macos 规范

完整细则见 `docs/engineering/macos-and-privacy.md`。

- 所有 AppKit 调用在主线程执行；跨线程入口需显式切换并在注释中说明。
- 每个 `unsafe` 块写 `// SAFETY:`，说明指针来源、生命周期与线程前提。
- 窗口句柄、监听器、采集流有唯一所有者与释放时机；覆盖层销毁时停止所有采集与计时器。
- 不在启动时申请屏幕录制、麦克风等权限；仅在用户触发相关能力时申请，拒绝后降级。
- 覆盖层与工具栏的 `sharingType`、`ignoresMouseEvents`、窗口层级改动，需在会议软件矩阵中实测（见 `docs/engineering/macos-and-privacy.md`）。
- Swift-only 系统 API（如较新的 Vision / Speech 接口）通过独立 Swift 桥接层暴露 C ABI，不在本 crate 内手写不安全的 Swift 运行时调用（见 ADR-003）。
