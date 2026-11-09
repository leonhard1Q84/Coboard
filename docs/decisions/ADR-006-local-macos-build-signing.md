# ADR-006：本地 macOS 应用包使用 ad hoc 签名

- 状态：已采纳
- 日期：2026-11-09

## 问题

Tauri 未配置签名身份时可以产出 `.app`，但其中的 Apple Silicon 可执行文件只有链接器签名，应用资源未封装到签名中。实际运行 `codesign --verify --deep --strict` 报 `code has no resources but signature indicates they must be present`，因此构建命令成功不足以证明应用包有效。

## 决策

- 当前本地构建将 `bundle.macOS.signingIdentity` 设为 `-`，由 Tauri 对完整应用包进行 ad hoc 签名，无需读取开发者凭据或连接外部服务。
- 构建运行脚本在启动前执行完整应用包的严格签名校验；校验失败则停止。
- 不添加未经运行验证所需的 entitlement，不降低系统信任策略。

## 边界与验证

这只服务于本机开发和本地打包，不能证明开发者身份，也不代替 Developer ID 签名、正式分发与 Apple 公证。将来分发需另行配置正式签名身份及公证流程。

验证命令：`./script/build_and_run.sh --verify`；独立校验可用 `codesign --verify --deep --strict target/debug/bundle/macos/Coboard.app`。窗口显示与文档恢复须另作运行验证。
