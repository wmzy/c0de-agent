# 项目路由化（History 模式 + 项目 id 入路由）设计

- **日期**: 2026-06-28
- **状态**: 已批准
- **范围**: 前端路由由 hash 改为 history，项目 id 作为路由顶级维度
- **关联**: `2026-06-28-project-support-design.md` §9（前端）的细化

## 1. 目标

- 路由切换为 history 模式（`BrowserRouter`），URL 干净可分享、可刷新。
- 项目 id 作为路由顶级维度，URL 完整表达「项目 + 会话」上下文。
- 项目选择从组件内临时态提升为路由态，刷新/分享/后退均可还原。

## 2. 路由结构

```
/                                          → RootRedirect  (查 current 项目，replace 到 /projects/:id)
/projects/:projectId                       → ChatPage      (项目会话列表，无选中会话=空状态)
/projects/:projectId/sessions/:sessionId   → ChatPage      (具体会话)
/settings                                  → Layout(TopBar + Settings)
*                                          → NotFound
```

## 3. 组件改造

### RootRedirect（新增）
`useQuery` 拉 `projectAPI.current()`：加载中显示 loading；成功 `navigate('/projects/'+id, {replace:true})`；失败显示错误引导（不静默循环）。

### ChatPage
`useParams` 读 `projectId` + `sessionId`，下传 `SessionList` / `ChatView`。
选会话 → `navigate(`/projects/${projectId}/sessions/${id}`)`。
新建会话 → `create.mutate({projectId})`（projectId 恒有值）→ 跳项目会话路径。

### SessionList
过滤态移除组件内 `useState`，改为以 props `projectId` 为准。`onSelect` 已由 ChatPage 导航处理。

### ProjectSwitcher：过滤器 → 项目导航器
切换项目即 `navigate('/projects/'+newId)`（切换项目清空当前会话）。
`Selection` 简化为纯 `projectId: string`，**移除 `ALL`/`UNASSIGNED`**。
未关联项目（`projectId=null`）的会话不在任何项目视图显示——「项目为顶级维度」的预期语义。

### TopBar
「会话」链接动态化：`useParams` 取到 `projectId` 则跳 `/projects/:id`，否则跳 `/`（走 RootRedirect）。

## 4. SPA fallback

- **dev**：`honoApiPlugin` 仅拦 `/api`，其余 `next()` 交给 Vite 默认 `appType:'spa'` history fallback，无需改配置。
- **生产**：部署服务器需 `try_files` 回退到 index.html（部署层，本次代码不含）。

## 5. 测试

- `TopBar.test`：项目上下文下「会话」链接指向 `/projects/:id`；无项目时指向 `/`。
- 新增项目路由集成断言（渲染于项目路由 MemoryRouter）。
- 遵循 AGENTS.md：追加/复用现有测试文件，不建孤岛。

## 6. 影响文件

- `src/web/App.tsx`
- `src/web/components/ProjectSwitcher.tsx`
- `src/web/components/TopBar.tsx`
- `src/web/views/SessionList.tsx`
- `src/web/components/TopBar.test.tsx`（+ 项目路由断言）
