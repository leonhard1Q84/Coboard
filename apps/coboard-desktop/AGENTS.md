# coboard-desktop 规范

Tauri v2 宿主 + React 19 / TypeScript / Zustand 前端。UI 必须遵循 `docs/design/ui-guidelines.md`。

## 目录

```text
src/
  main.tsx              # 只做挂载
  App.tsx               # 界面装配：画布 + 标题栏 + 提示 + HUD + 工具栏
  ipc/types.ts          # 与 coboard-domain 序列化一致的类型（后续由 Rust 生成）
  stores/               # Zustand：session（持久化队列）、document（乐观视图）、tools、viewport
  features/canvas/      # 画布：书写、渲染、命中测试、文本编辑
  features/toolbar/     # 工具栏与图标
  features/chrome/      # 标题栏、提示条、HUD、缩放指示
  styles/tokens.css     # 设计令牌（唯一的颜色 / 尺寸来源）
  styles/app.css        # 布局与组件样式，只引用令牌
src-tauri/              # Tauri 装配与 IPC 命令
```

## 规则

- **书写热路径不等待 IPC**：指针事件 → 1€ 平滑 → 实时层绘制全部在前端完成；抬笔后才 `edit()` 一次，作为一个撤销单元。
- **持久化只经 `useSession().edit()`**：它负责乐观显示、串行发送与失败保留。组件不直接 `invoke('apply_edit')`，也不在保存期间禁用画布。
- 失败时队列暂停，内容留在画布上；确定性拒绝（`invalid_edit` 等）丢弃该项并提示，不阻塞后续编辑。
- 渲染分层：`scene` 画布绘制已提交和乐观状态的墨迹；DOM 层显示文字、公式、卡片；`live` 画布绘制实时笔迹、激光、选框和工具光标。
- 单键快捷键在输入框聚焦或输入法组字（`isComposing` / keyCode 229）时不得响应；Enter 提交同样要检查组字状态。
- 样式只用 `tokens.css` 中的变量；新颜色先加令牌。组件内不写十六进制颜色（墨迹存储值 `INK` 例外，需与令牌一致）。
- 主界面不显示修订号、路径等诊断信息；诊断放在保存状态的 tooltip。
- 视图状态（视口、选择、当前工具）不写入文档。
- 代码风格：每个 JSX 属性过长时换行；单文件只放一个主要组件；纯函数（几何、文档变换）与 React 组件分开，便于测试。

## 验证

```sh
npm test          # 会话队列与乐观视图
npm run build     # typecheck + 打包
npm run tauri dev # 真实 IPC：书写 → 退出 → 重开，笔迹恢复
```

UI 改动按 `docs/design/ui-guidelines.md` §9 清单自查，深浅色都要看。
