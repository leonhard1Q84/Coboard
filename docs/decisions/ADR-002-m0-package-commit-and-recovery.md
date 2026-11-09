# ADR-002：M0 文档格式、单写会话与持久化提交协议

- 状态：已采纳（M0 实现；正式文件兼容策略仍需后续里程碑验证）
- 日期：2026-11-08
- 前置：[ADR-001](ADR-001-tech-stack-and-storage-architecture.md)、仓库 `AGENTS.md`

## 背景

M0 必须把编辑、撤销重做和崩溃恢复接到真实持久化路径。Loro 的事务是历史分组机制，不提供数据库式回滚；SQLite 与外部资源也不是同一个原子事务。不能先发布内存状态，再把数据库失败当作“已保存”。

ADR-001 中 `synchronous=NORMAL` 是早期方向，不能作为“确认提交具备最强可用落盘保证”的实现依据。本决策为 M0 明确提交点、格式和能力边界。

## 决策

### 1. 包结构与版本

```text
example.coboard/
  manifest.json          # format="coboard"、format_version=1、document_id
  document.db            # PRAGMA user_version=1
  document.db-wal        # SQLite 自主管理；不可在打开期间手工清理
  document.db-shm
  .writer.lock           # OS 文件锁；文件存在本身不代表被锁定
  assets/<前两位>/<64位 BLAKE3 十六进制哈希>
```

- 资源不依赖扩展名；AST 中保留其用途和来源。网关当前统一以 `application/octet-stream` 发送，禁止内容嗅探。
- JSONML 顶层节点为 `[tag, attrs, ...children]`，支持 `derivation_card`、`paragraph`、`math_block`、`image`、`stroke`、`connector`。
- 公共属性含稳定 `id`、画布 `position` 和可选 `source: {asset, rect, page}`；`rect` 为源坐标，独立于画布移动。卡片子块只允许段落与公式，防止无界递归。
- 文档、节点和操作的未知字段／标签拒绝解析；未知包版本、DB 版本、AST 版本不写入、不迁移、不覆盖原件。
- 新包使用独占目录创建，最后通过同目录临时文件、同步与不覆盖发布写入 `manifest.json`。manifest 是创建完成标记；中断留下的目录不会被当作空文档覆盖。

### 2. 状态和修改入口

- 领域 `Editor` 是唯一编辑规则入口；命令在副本上应用并检查完整图不变量，成功后整体发布。一次 `Edit {operations}` 对应一个撤销单元，拖拽与笔迹中间采样不提交。
- 插入、替换、删除、移动、命名、撤销和重做使用相同的修订检查；撤销与重做仍增加修订号。
- 领域层不依赖存储、时间、窗口或网络。应用会话在 Tauri 装配处持有唯一 `Package`，阻塞工作通过 `spawn_blocking` 执行。
- 每次只有一个在途会话任务；额外请求返回 `busy`，前端保留待重试请求。写入进行时阻止普通窗口关闭与正常退出；不依赖退出回调保障恢复。
- 每个写请求有 `request_id + expected_revision + action`。SQLite 保存请求摘要，同一 ID／同一内容重试返回原确认，不重做命令；ID 复用为其他内容时报错。若 COMMIT 回应不确定，重试会核对持久化状态。

### 3. 资源与数据库的提交顺序

1. 资源先写到 CAS 同目录临时文件，写完整后 `sync_all`，重新计算 BLAKE3 校验，不覆盖地发布最终哈希文件，再同步目录。
2. 编辑在领域候选副本上验证，校验当前资源引用。缺失或损坏资源不允许生成新的已确认引用。
3. Loro 使用独立 fork 承载候选修改，保持单写本地 peer ID；只对变化对象和元数据生成 `ExportMode::updates`。对象以原子 JSONML 值存入 Loro map，当前不提供字段级协同合并。
4. SQLite `BEGIN IMMEDIATE` 内校验持久化 head，追加增量 OpLog 与校验摘要，更新 head、FTS5，以及需要生成的快照。每 128 次提交保存 zstd AST 和 Loro snapshot，二者都带摘要。
5. `COMMIT` 成功后才替换内存 Editor 和 Loro，返回“已保存”。SQL 或资源失败时，原内存文档、历史与已确认数据不变；前端保留同一请求及输入草稿供重试。

使用 `journal_mode=WAL`、`synchronous=FULL`；macOS 额外启用 SQLite `fullfsync` 和 `checkpoint_fullfsync`。这是对 ADR-001 的明确收紧；不以吞掉同步开销来实现 `<3 ms` 的表面指标。

资源在 DB 前提交，因此中断最多留下未引用资源／暂存文件，不会产生已提交的半个资源文件。当前不自动清理这些文件，也不裁剪 OpLog 或旧快照，避免误删撤销／恢复／未来时间线仍需的创作历史。正式 GC 需要单独的可重放保留策略。

### 4. 恢复和错误

- 打开先检查 manifest、受管路径、写锁和 DB 版本，再检查 SQLite、快照摘要及 AST／Loro 一致性，按修订顺序导入快照之后的 Loro 增量。
- 日志序列必须连续，最终内容摘要、修订号必须与独立 `document_head` 匹配；删除尾行或篡改更新不静默当作成功恢复。
- 已知缺失资源作为恢复报告返回，保留对象和原引用；资源校验失败不妨碍显示其他文字。损坏 DB／快照／日志目前拒绝可写打开并保留原件，部分只读抢救 UI 后续实现。
- 文件锁只允许一个进程写同一文档。对象修订检查和 SQLite head 检查仍保留，不把文件锁误当作所有并发场景的充分保证。
- 包根路径可以由用户选定；内部资源只由校验过的十六进制哈希寻址。拒绝数据库、WAL／SHM、锁、资源目录及资源文件边界的符号链接。尚不提供对恶意并发进程替换路径的 `openat` 级防护或 NSFileCoordinator。

### 5. 生命周期和预算

- 操作恢复日志、当前会话的 Undo/Redo、未来讲解时间线是三种独立状态。撤销最多 256 个单元，同时按序列化体积限制到 16 MiB；重启恢复文档，但不恢复撤销栈。
- 单个资源 32 MiB；文档 AST、单次请求／更新／快照 64 MiB；快照解压有硬上限，SQLite 值读取也设置长度上限。
- 单节点正文 256 KiB，单笔 100,000 个采样点，单卡片 1,024 个块，单事务 4,096 个操作，最多 100,000 个对象。它们是拒绝异常输入的安全上限，不是当前交互性能承诺。
- Axum 只绑定 `127.0.0.1` 随机端口，资源使用进程内临时 Bearer token；限制允许的 Origin，支持单段 HTTP Range，最多四路校验／资源流，断开即释放。M0 不监听局域网，也不开放文档写 HTTP API。

## 权衡与未完成项

- 暂不引入 sqlite-vec、模型运行时、PDF 引擎或画布引擎，避免与 M0 无关的体积、许可证和初始化成本；FTS5 已接入真实事务，`timeline_events` 只建立独立表。
- 领域候选副本、完整状态摘要和 Loro fork 当前包含 O(n) 工作。它们换取清晰的失败隔离；达到输入关键路径预算前，需要基于测量改进，不能宣称已达到零技术债或大画布性能目标。
- 当前测试证明独立进程强制终止后的已提交状态恢复，不证明实际断电、磁盘控制器缓存行为、网络卷／外接卷，以及完整文件协调与沙盒授权。
- M4 前必须定义字段级协同、冲突与 schema 兼容、配对认证和取消语义，再接入跨端导入；当前不允许任意外部 CRDT 更新绕过领域校验。

## 验证依据

可执行测试位于 `crates/coboard-domain`、`crates/coboard-storage`、`crates/coboard-server`，前端保存状态测试位于 `apps/coboard-desktop/src/session.test.ts`。命令和实际环境记录见 [M0 实现说明](../development/m0-foundation.md)。
