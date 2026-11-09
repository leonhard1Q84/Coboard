# Coboard 协作规范（根）

Coboard 是 macOS 本地的**屏幕共享即时讲解工具**：共享屏幕时随时呼出覆盖层圈画、取材、推导；也能在独立画布窗口里直接书写演示。技术形态为 Tauri v2 + Web 画布前端 + Rust 核心。

本文件只放全仓库通用的硬规则与索引。细则按目录就近放置（子目录 `AGENTS.md` 优先于本文件），长篇说明放 `docs/`。

## 仓库地图

| 路径 | 职责 | 就近规范 |
| --- | --- | --- |
| `apps/coboard-desktop/` | Tauri 宿主 + React/TS 画布前端 | `apps/coboard-desktop/AGENTS.md` |
| `crates/coboard-domain/` | 纯领域规则：文档模型、编辑命令、撤销重做、笔迹几何 | 不依赖 UI / 文件 / 网络 / 平台 |
| `crates/coboard-storage/` | `.coboard` 包、SQLite WAL、提交与恢复、BLAKE3 资源池 | `crates/coboard-storage/AGENTS.md` |
| `crates/coboard-macos/` | NSPanel 覆盖层、穿透、屏幕采集等原生桥接 | `crates/coboard-macos/AGENTS.md` |
| `crates/coboard-server/` | 本地媒体网关（去留见 ADR-003） | — |
| `crates/coboard-ai-client/` 等空 crate | 占位，暂无实现 | `crates/coboard-ai-client/AGENTS.md` |
| `docs/product/` | 定位、PRD（带优先级）、路线图 | — |
| `docs/design/` | UI 视觉与交互规范、设计令牌 | `docs/design/ui-guidelines.md` |
| `docs/engineering/` | 架构、可靠性、性能、平台与隐私、验证细则 | — |
| `docs/decisions/` | ADR：技术选型唯一来源 | — |

## 命令

```sh
cargo test --locked && cargo fmt --all -- --check && cargo clippy --locked --all-targets -- -D warnings
cd apps/coboard-desktop && npm ci && npm test && npm run build   # 前端
cd apps/coboard-desktop && npm run tauri dev                     # 完整桌面会话
```

## 硬规则

1. **一进来就能画**：启动后画布即可书写；数据库打开、恢复、模型、网络都不阻塞输入。
2. **书写路径零阻塞**：指针到墨迹只在前端完成，不等待 IPC、磁盘或网络；持久化异步排队。
3. **文档只经编辑命令修改**：一次连续笔迹或拖拽是一个撤销单元；预览与手势中间态不提交。
4. **"已保存"必须真实**：只有收到持久化确认才显示已保存；失败保留内容并提供重试。
5. **离线完整**：网络、账号、模型故障不得阻断本地创作与保存。
6. **领域层纯净**：`coboard-domain` 不依赖 UI、文件系统、数据库、网络或 macOS API。
7. **错误显式**：Rust 用 `Result` 和明确错误类型；外部输入路径禁止 `unwrap` / `expect`；`unsafe` 写 `// SAFETY:`。
8. **UI 只说用户语言**：修订号、文件路径、内部模块名不出现在主界面；颜色、间距、字号只用 `tokens.css` 令牌。
9. **隐私默认本地**：内容发往联网服务前须用户授权范围；凭据只进 Keychain；日志不含用户内容。
10. **不提前抽象**：不引入插件系统、通用事件总线；新依赖说明用途、体积、许可证。空 crate 不新增。
11. **选型留痕**：影响依赖、文件格式、平台边界的决定写 ADR；性能结论注明测量条件。
12. **交付诚实**：说明行为变化、验证依据与限制；不编造通过的测试或未实测的性能。

## 细则索引

- 分层、状态与并发：`docs/engineering/architecture.md`
- 失败处理、文件格式、错误与日志：`docs/engineering/reliability.md`
- 启动与书写性能预算：`docs/engineering/performance.md`
- 多窗口、覆盖层、屏幕共享、隐私与权限：`docs/engineering/macos-and-privacy.md`
- 测试与交付：`docs/engineering/verification.md`
- 联网服务客户端：`crates/coboard-ai-client/AGENTS.md`
