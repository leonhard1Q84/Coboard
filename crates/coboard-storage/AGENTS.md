# coboard-storage 规范

完整细则见 `docs/engineering/reliability.md`，提交协议见 `docs/decisions/ADR-002-m0-package-commit-and-recovery.md`。

- 只有在 SQLite 事务提交并按 ADR-002 同步后才返回成功回执；调用方据此显示"已保存"。
- 同一 `request_id` 的重放必须幂等；同一 ID 对应不同内容返回 `request_conflict`。
- 资源写入：同目录临时文件 → 校验 → 原子 rename；从不覆盖已有哈希文件。
- 读取较新 schema 时阻止写入，不静默丢弃未知数据。
- 改动提交或恢复路径时，必须运行 `cargo test --locked -p coboard-storage --test crash_recovery -- --nocapture` 并在交付中附实测数字与构建条件。
- 新增错误类型时同步更新 `StorageError::code()` 与桌面端用户文案映射。
