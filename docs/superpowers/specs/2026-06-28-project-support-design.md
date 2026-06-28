# 项目支持（Project Support）设计

- **日期**: 2026-06-28
- **状态**: 已批准（待实现计划）
- **参考**: opencode `packages/opencode/src/project/`
- **范围**: 多项目管理 + session 归属 + 前端项目视图

## 1. 目标与非目标

### 目标
- 服务器能识别并管理多个项目目录，每个项目有稳定唯一标识。
- 每个 session 可关联一个项目（可选），不同项目的 session 在各自工作目录运行 agent。
- 浏览器前端按项目分组会话、显示当前项目信息（名称 + git 分支）、支持项目切换。

### 非目标（YAGNI，明确剔除）
- icon/commands/sandboxes 等 opencode 字段（Browser-Server 架构用不到）。
- git vcs 完整集成（diff/patch/track 变更）。
- `initGit`（在非 git 目录初始化 git 仓库）。
- 跨实例项目 ID 迁移（opencode 的 `migrateProjectId`）。

## 2. 项目标识策略

采用 **混合：git 优先 + 路径回退** 方案。

- **git 仓库内**：用 git remote URL（无 remote 则取 worktree 根路径）的 sha256 前 16 位作为 `projectId`。同一仓库的不同子目录 / worktree / 克隆 → 同一 `projectId`。目录移动后靠 remote 仍能关联历史 session。
- **非 git 目录**：用目录绝对路径的 sha256 前 16 位。目录移动/重命名后关联会丢失（接受的取舍）。

## 3. 架构融入方式

采用 **方案 A：项目绑定 session（可选归属）**。

- `session.projectId` 可空（向后兼容）。
- agent run 时：若 `session.projectId` 存在 → 查 `project.worktree` → `deps.cwd = worktree`；否则回退 `ctx.cwd`。
- 前端按项目分组会话 + 显示当前项目 + 项目切换。

排除的备选方案：
- B 全局当前项目状态：`ServerContext.currentProject` 全局状态，并发多项目会话不友好。
- C 项目纯分组：不改变 agent cwd，项目无工作区意义，价值打折。

## 4. 数据模型（Drizzle）

### 新增 `projects` 表
```ts
projects = pgTable('projects', {
  id:        text('id').primaryKey(),                       // projectId: sha256[:16]
  worktree:  text('worktree').notNull(),                    // 项目工作目录绝对路径
  vcs:       text('vcs'),                                   // "git" 或 null
  name:      text('name'),                                  // 可编辑项目名（默认 worktree basename）
  gitRemote: text('git_remote'),                            // git remote URL 快照，可空
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
})
```
索引：无特殊需求（id 主键已足够，list 全表扫描可接受）。

### `sessions` 表加列
```ts
projectId: text('project_id').references((): AnyPgColumn => projects.id, { onDelete: 'set null' })
// 可空 → 向后兼容；历史 session 归"默认"组
```
新增索引：`idx_sessions_project` on `projectId`。

### Migration
- 新建 drizzle migration：建 `projects` 表 + `sessions` 加 `projectId` 列（NULL 默认）+ 索引。
- 历史 session：`projectId=null`，完全可访问，agent 用 `ctx.cwd`。

## 5. 项目解析算法

实现位置：`src/project/resolve.ts`。

```
resolveProject(directory) → { id, worktree, vcs, gitRemote?, gitBranch? }

  1. 将 directory 规范化为绝对路径。
  2. 向上查找 .git（目录或文件）→ 定位 git 仓库根。
  3. git 仓库:
       worktree   = git 仓库根路径
       gitRemote  = `git -C <root> remote get-url origin`
                    （失败取首个 remote: `git remote` 取第一行再 get-url; 再失败为 null）
       gitBranch  = `git -C <root> rev-parse --abbrev-ref HEAD`（失败为 null）
       id         = sha256(gitRemote || worktree).slice(0, 16)
       vcs        = "git"
  4. 非 git:
       id         = sha256(absolutePath).slice(0, 16)
       vcs        = null
       gitRemote  = null
  5. 优雅降级: 所有 git 命令 spawn 失败 → 回退为路径方案，不抛错。
```

- git 探测使用 `node:child_process` 的 `spawnSync`（同步，解析阶段无并发需求）。
- 所有 git 命令包裹 try/catch，失败返回空字符串而非抛错。

## 6. 模块结构

```
src/project/
  resolve.ts   — resolveProject() + git 探测（spawnSync）
  project.ts   — DB 操作: fromDirectory / list / get / getByDirectory / updateName
  index.ts     — 导出
```

### API 契约
```ts
// resolve.ts
type ResolvedProject = {
  id: string
  worktree: string
  vcs: 'git' | null
  gitRemote: string | null
  gitBranch: string | null
}
function resolveProject(directory: string): ResolvedProject

// project.ts
type Project = {
  id: string
  worktree: string
  vcs: 'git' | null
  name: string | null
  gitRemote: string | null
  createdAt: number
  updatedAt: number
}
// DB 操作（均接收 DB handle）
function fromDirectory(handle: DB, directory: string): Promise<Project>      // 解析 + upsert
function listProjects(handle: DB): Promise<Project[]>
function getProject(handle: DB, id: string): Promise<Project | null>
function getByDirectory(handle: DB, directory: string): Promise<Project | null>   // GET /current 即调用此（参数 ctx.cwd）
function updateProjectName(handle: DB, id: string, name: string): Promise<Project | null>
```

### 与现有类型对齐
- `core/types.ts` 已有 `ProjectInfo`（name/language/framework/rootDir/gitBranch）。`resolveProject` 输出复用于 agent prompt 的 `ProjectInfo`（gitBranch 字段直接映射；language/framework/rootDir 由调用方补充）。

## 7. HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/projects/from-directory` | body `{directory}` → 解析 + upsert，返回 project（含实时 gitBranch） |
| GET | `/api/projects` | 列出所有项目 |
| GET | `/api/projects/current` | 返回 `ctx.cwd` 对应项目（前端默认展示） |
| GET | `/api/projects/:id` | 详情 + 实时 gitBranch |
| PATCH | `/api/projects/:id` | body `{name}` 更新项目名 |
| GET | `/api/sessions?projectId=X` | 按项目过滤会话（扩展现有 session route） |
| POST | `/api/sessions` | 新增可选 body `{directory}` → 自动解析并关联 projectId |

### 实时 gitBranch
DB 存 `gitRemote` 快照，但 `gitBranch` 随 checkout 变化，故 API 返回时**实时调用 `resolveProject(worktree)` 取最新 gitBranch**，不持久化分支。

### 文件结构
- `src/server/routes/project.ts` — 新建，`createProjectRoute(ctx)`
- `src/server/app.ts` — 注册 `app.route('/api/projects', createProjectRoute(ctx))`
- `src/server/routes/session.ts` — 扩展 `projectId` query 过滤 + 创建时关联

## 8. agent 工作目录改造

### 当前（`src/server/routes/chat.ts`）
```ts
const deps = { ..., cwd: ctx.cwd }   // 单值，所有 session 共用
```

### 改造后
```ts
// chat.ts 构造 deps 前
const project = session.projectId ? await getProject(ctx.db, session.projectId) : null
const cwd = project?.worktree ?? ctx.cwd
const deps = { ..., cwd }
```

**核心价值**：不同项目的 session 在各自目录执行 read/write/bash 工具。

## 9. 前端（React + 现有 haze-ui）

### 改动点
- **`services/project.ts`**（新建）：API 客户端 `listProjects / getCurrentProject / getProject / fromDirectory / updateProjectName`。
- **`SessionList.tsx`**（改）：按 `projectId` 分组会话（无项目的归"默认"组）。
- **顶栏项目指示器**（新增组件）：当前项目名 + git 分支（`GET /api/projects/current`）。
- **项目切换**：选择项目 → 过滤该项目的会话；新建会话时归属当前选中项目。

### 状态管理
- `ConfigContext` 或新增 `ProjectContext`：持有 `currentProject` + `selectedProjectId`。
- 新建会话时把 `selectedProjectId`（或其 directory）传入 `POST /api/sessions`。

## 10. 迁移与兼容

- drizzle migration：建 `projects` 表 + `sessions` 加 `projectId` 列 + 索引。
- 历史 session：`projectId=null`，归"默认"组，完全可访问，agent 用 `ctx.cwd`。
- 所有改动向后兼容：无 projectId 的 session 行为不变。

## 11. 测试策略

遵循 AGENTS.md 测试放置规范：追加到现有文件，不新建孤岛。

### resolveProject（新建 `src/project/resolve.test.ts`，因新模块无对应现有文件）
- git 目录 → 正确 id/worktree/vcs/gitRemote
- 非 git 目录 → 路径 hash id，vcs=null
- git 仓库内嵌套子目录 → 返回仓库根（向上查找生效）
- 无 remote 的 git 仓库 → 回退 worktree 路径 hash
- git 命令失败（git 未安装场景模拟）→ 优雅降级为路径方案，不抛错

### project DB 操作（追加到 `src/db/integration.test.ts`）
- fromDirectory upsert 幂等
- list / get / updateName

### session projectId 关联（追加到 `src/session/session.test.ts`）
- 创建 session 带 directory → projectId 正确
- 无 directory → projectId=null
- agent cwd 来源（追加到 `src/server/routes/chat.test.ts`）

### API 端点（新建 `src/server/routes/project.test.ts`）
- POST /from-directory / GET / / GET /current / GET /:id / PATCH /:id

## 12. 依赖与影响面

### 新增依赖
- 无（`node:child_process`、`node:crypto` 均内置；Drizzle/Hono 已有）。

### 改动文件清单
- `src/db/schema.ts` — 加 projects 表 + sessions.projectId
- `src/drizzle/0001_*.sql` — 新 migration（生成）
- `src/project/resolve.ts` — 新建
- `src/project/project.ts` — 新建
- `src/project/index.ts` — 新建
- `src/server/routes/project.ts` — 新建
- `src/server/routes/session.ts` — 扩展 projectId 过滤 + 创建关联
- `src/server/routes/chat.ts` — deps.cwd 按 project.worktree
- `src/server/app.ts` — 注册 projects 路由
- `src/server/types.ts` — ServerContext 无需改（cwd 保留作回退）
- `src/session/session.ts` — createSession 接收可选 directory/projectId
- 前端：`services/project.ts`（新）、`SessionList.tsx`、顶栏组件、Context

### 不变项
- core/loop、tools、llm、plugins、db/client 不受影响。
- `ctx.cwd` 保留，作为无项目 session 的回退。
