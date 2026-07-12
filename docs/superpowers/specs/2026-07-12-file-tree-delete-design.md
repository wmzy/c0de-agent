# 文件树删除操作 — 移入系统回收站

## 目标

在文件浏览器（FileBrowser / FileTree）中为每个文件和目录节点添加删除按钮。
删除操作将目标移入**操作系统回收站**（非永久删除），用户可从 OS 回收站恢复。

## 方案选择

- **系统回收站**（`trash` 包）：文件离开 worktree，git 零感知，恢复交给 OS。
- ~~`.c0de/trash/`~~：会被 git 跟踪，需侵入 `.gitignore`。
- ~~`.git/trash`~~：`.git/` 是 git 内部目录，写入有破坏仓库风险。

## 改动

### 后端

`src/server/routes/files.ts`：
- 新增 `DELETE /api/files/*?projectId=` 路由
- 复用 PUT 的 projectId→root 解析逻辑
- `safeResolve` 路径穿越校验 → `access()` 存在性检查 → `trash(resolved)` → `{ path, trashed: true }`
- 错误：403 越界 / 404 不存在 / 500 trash 失败

### 前端 service

`src/web/services/file.ts`：
- 新增 `fileAPI.delete(path, projectId)` → `DELETE /api/files/<path>?projectId=`

### 前端组件

`src/web/components/FileTree.tsx`：
- 新增 `onDelete?: (path: string) => void` prop
- 每行 hover 显示 🗑 按钮（紧挨 @ 按钮，相同样式，`data-delete-btn`）
- 搜索结果行同步添加删除按钮

`src/web/views/FileBrowser.tsx`：
- 新增 `onDelete?: (path: string) => void` prop（透传给 App）
- `handleDelete`：`window.confirm()` → `fileAPI.delete()` → 本地从树中移除节点（`removeNode`）→ 调用 `onDelete`
- 新增 `removeNode(root, path)` 不可变移除

`src/web/App.tsx`：
- 向 FileBrowser 传入 `onDelete`：若被删文件/目录是当前预览目标（含子路径），关闭预览

## 测试

- 后端 `files.test.ts`：DELETE 文件 → trashed + 文件消失；DELETE 目录；越界 403；不存在 404
- 前端 `FileBrowser`：🗑 按钮渲染；确认后调 API；取消不调；删除后树移除节点
