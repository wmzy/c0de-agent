# 开发指南

面向要读/改本仓库代码的人。产品功能看 [README.md](./README.md)，仓库级硬性约定（测试并发、迁移生成、lint 等）看 [AGENTS.md](./AGENTS.md)。

## 启动链路

### `c0de serve`（Web 服务）

`src/cli/index.ts` 解析命令（`parser.ts`）→ `src/cli/commands/serve.ts` → `src/server/index.ts` 的 `startServer`（默认端口 7310，`src/server/server.ts`）→ `server.ts` 组装 `ServerContext`（配置、PGLite、认证、agentManager）→ `src/server/app.ts` 的 `createApp` 挂中间件与路由。常用 flag：`--port` / `--host` / `--open` / `--restore <快照>`（热更新接力用）/ `--handoff-port`。其余子命令在 `src/cli/commands/`：`chat`、`acp`、`config`、`init`、`plugin`、`sessions`、`trust`、`update`、`auth`。

- 路由全部在 `src/server/routes/`（chat、session、config、provider、files、kanban、terminal、update、usage 等 20 个文件），每个文件一个 `create<Domain>Route(ctx)` 工厂。探活：`curl http://127.0.0.1:<port>/api/health`（`routes/health.ts`，认证放行）。
- 认证/配对在 `server/auth-manager.ts`（设备 token、6 位配对码），CORS/认证/错误中间件在 `server/middleware/`；终端（node-pty）在 `server/terminal/`。

**一次聊天请求的生命周期**（自上而下读代码的主线）：

1. `routes/chat.ts` 校验请求、建立 SSE 连接，把 run 注册进 `server/agent-manager.ts`（活跃 run 管理、断连/中止）。
2. 组装 `LoopDeps` 进入 `src/core/loop.ts` 的 `agentLoop`（AsyncGenerator，逐个产出 `AgentEvent`）——主循环是 `core/loop/` 子模块的编排点：流收集（`stream-collect.ts`）、上下文压缩（`compaction.ts`）、持久化（`persist.ts`）、子 agent（`subagent.ts`）。
3. 每轮 LLM 调用经 `src/llm/provider.ts` 抽象 → 协议实现 `llm/protocols/openai-compat.ts`；失败按 `llm/retry.ts` / `llm/routing.ts` 重试与回退。
4. 工具调用由 `src/tools/executor.ts` 执行（注册表 `tools/registry.ts`、启用解析 `tools/resolver.ts`）；需要确认的工具经 `server/permission/interactive.ts` 挂起，等待用户在 Web 弹窗批准（`permission/stream-checker.ts` 负责流内等待与超时）。
5. 会话状态由 `src/session/` 维护：消息/上下文（`context.ts`/`message.ts`）、压缩归档（`compaction.ts`/`archive.ts`）、快照（`snapshot.ts`），并经 `src/db/` 落 PGLite。

### 开发模式（`pnpm dev`）

vite 单端口 3020：`vite.config.ts` 的 `honoApiPlugin` 把 `src/server/dev.ts` 经 `ssrLoadModule` 挂到 `/api` 中间件，前后端同端口、前端热更新。终端 WebSocket 走 `/api/terminal/:id/ws`（同插件内处理 upgrade）。`.env` 的 `C0DE_*` 由该插件手动注入 `process.env`（vite 8 不再自动合并，详见 AGENTS.md）。开发隔离：复制 `.env.example` 为 `.env` 后，全局配置与运行时数据重定向到仓库内 `.c0de-dev/`（已 gitignore），与 `npm i -g` 安装版互不干扰、可同时运行。

### `c0de chat`（打印模式）

`src/cli/commands/chat.ts` → `src/cli/modes/print.ts`：单次问答、不启动服务。PGLite 单写者——serve 运行期间默认拒绝（提示用 `--temp` 走临时会话）。

### `c0de acp`

`src/cli/commands/acp.ts` → `src/cli/modes/acp.ts`：ACP 协议 over stdio，供宿主编辑器集成。

## 配置与作用域

- 两层配置：全局（`~/.c0de/config.json`，`C0DE_CONFIG_DIR` 可重定向）与项目（`<repo>/.c0de/config.json`），经 `src/core/config.ts` 的 `loadConfigScopes` / `mergeConfig` 合并；`security.*` 等服务端全局键在项目作用域加载时剥离（AGENTS.md §7）。
- 项目信任门禁：未信任项目的风险配置（权限降级、插件、MCP、自定义 baseURL）在聊天入口被拦。`src/project/trust.ts` 负责风险摘要与信任指纹（口径见 AGENTS.md §9），Web 侧引导在 `server/routes/trust-gate.ts`。
- 斜杠命令：`src/core/slash.ts`（Web 与 CLI 共用）；`/config` 的点路径读写工具在 `src/core/config-path.ts`（含原型链键防护）。
- 工作流脚本：三级来源——builtin（`core/workflows/builtins.ts`）、用户级 `~/.c0de/workflows/*.js`、项目级 `.c0de/workflows/*.js`；发现/注册/执行在 `src/core/workflows/`，REST 入口 `routes/workflows.ts`。

## 扩展点

- **插件**：项目 `.c0de/plugins/` 目录（项目未信任或指纹漂移时不加载，与聊天门禁同口径）。12 个生命周期钩子定义在 `src/plugins/types.ts` 的 `HookMap`（`agent:start/end`、`tool:before/after`、`provider:before/after`、`message:before/after`、`session:create/fork/compact`、`config:resolve`）；`:before` 是可改写/可中止的链、`:after` 是广播。
- **MCP 服务器**：配置键 `mcpServers`（stdio 或 streamable HTTP/SSE 传输），`src/mcp/tool-adapter.ts` 把远端工具以 `mcp__<server>__<tool>` 命名空间挂进工具注册表；项目作用域的 MCP 仅在项目已信任时连接。
- **技能（skills）**：`src/core/skills.ts` 发现项目 `.c0de/skills/` 与全局 `<config>/skills/` 下含 `SKILL.md` 的目录，注入 system prompt 的 `## Loaded Skills` 段。
- **仓库上下文文件**：`src/core/context-files.ts` 发现仓库自带的 AGENTS.md / CLAUDE.md / .cursor(rules) / .windsurf / copilot-instructions / .clinerules（规则见 README「仓库上下文文件」），经 prompt-registry 的 `repo-rules` 分片（priority 105）注入 system prompt；`@import` 递归展开、未闭合围栏补闭合；5s TTL 缓存发现结果。纯文本恒注入，不走信任门禁。
- **Magic keywords**：`src/core/magic-keywords.ts` 的关键字表是单一事实源（id/word/requires/notice）；匹配 = `stripMarkdownCode` 剥代码 + HTML 剥除 + ASCII 词边界正则（CJK 可贴词）。注入点：Web `routes/chat.ts` 与 CLI/ACP `modes/print.ts`（用户消息 → `buildMagicKeywordNotices` → `injectSteering`，同轮生效）。
- **提示词分片与覆写**：系统提示词由分片注册表组装（`src/core/prompt-registry.ts`，插件可注册分片）。内置静态分片正文存放在 `src/core/prompts/*.md`（文件名即分片 id），改后跑 `pnpm gen:prompts` 重新内联进 `prompts.generated.ts`。用户覆写层：全局 `<config>/prompts/*.md` 恒生效，项目 `.c0de/prompts/*.md` 仅项目已信任时生效（与插件/工作流门禁同口径）；文件名命中分片 id 即替换正文，否则按字典序追加为新分片，每轮对话重新读取（下一轮即生效）。
- **子 agent**：`src/core/agents/`（builtin 定义、registry、并行调度 `parallel.ts`）；主循环经 `core/loop/subagent.ts` 派生并收集产出（`outputSchema` 校验复用 `tools/validate.ts`）。

## src/ 目录导览

15 个顶层目录按依赖方向大致自上而下：入口（`cli`/`server`）→ 运行时（`core`/`llm`/`tools`/`session`）→ 基础设施（`db`/`project`/`update`/`plugins`/`mcp`/`dap`/`kanban`/`shared`）→ 前端（`web`）。

| 目录 | 职责 | 关键文件 |
| --- | --- | --- |
| `cli/` | CLI 入口与命令 | `index.ts` + `parser.ts`（命令解析）、`commands/`（serve/chat/config/trust/sessions/auth 等）、`modes/`（print/acp） |
| `core/` | 配置与 agent 运行时 | `config.ts`（作用域合并、fail-closed 启用语义）、`loop.ts` + `loop/`（主循环）、`prompt-registry.ts`、`context-files.ts`（仓库上下文文件发现/注入）、`magic-keywords.ts`（ultrathink/orchestrate/workflowz）、`slash.ts`、`workflow.ts` + `workflows/`（含内置 `review` 工作流）、`skills.ts`、`tool-exec.ts`、`agent.ts` + `agents/` |
| `llm/` | LLM provider 抽象 | `provider.ts`（流式接口）、`registry.ts`、`routing.ts`（回退）、`retry.ts`、`protocols/openai-compat.ts`（协议实现）、`schema/`（内部消息/events/options 层）、`model-catalog.ts` + `model-catalog.generated.ts`（生成式价目/上下文窗口目录，未配价目时的成本兜底） |
| `mcp/` | MCP 客户端 | `client.ts`、`transport.ts`（stdio + streamable HTTP/SSE）、`tool-adapter.ts`（`mcp__<server>__<tool>` 适配进工具注册表） |
| `server/` | Hono HTTP 服务 | `server.ts`/`app.ts`、`routes/`、`middleware/`、`permission/`（交互式权限）、`terminal/`、`agent-manager.ts`、`auth-manager.ts`、`dev.ts`（vite dev 挂载入口） |
| `session/` | 会话域 | `session.ts`/`context.ts`/`message.ts`、`compaction.ts`/`archive.ts`、`branch.ts`/`squash.ts`、`snapshot.ts`（序列化）、`trash.ts`（回收站）、`segments.ts`/`usage.ts`（用量） |
| `project/` | 多项目与信任 | `project.ts`/`detect.ts`/`resolve.ts`、`trust.ts`（风险摘要 + 信任指纹，见 AGENTS.md §9） |
| `db/` | Drizzle + PGLite | `schema.ts`（唯一 schema 源）、`client.ts`（PGLite client）、`migrate.ts`（启动迁移）、`test-utils.ts`（测试共享实例） |
| `tools/` | 工具系统 | `registry.ts`/`resolver.ts`、`executor.ts`、`permission.ts`、`builtin/`（内置工具实现，含 `lsp.ts` 的 `lsp`/`lsp_rename`）、`hashline/`、`websearch/` |
| `plugins/` | 插件系统 | `loader.ts`/`registry.ts`/`lifecycle.ts`/`hooks.ts`（12 个生命周期钩子）、`init.ts`、`builtin/` |
| `dap/` | Debug Adapter Protocol | `session.ts`、`protocol.ts`、`spawn.ts`（适配器映射：node/python/go/lldb） |
| `lsp/` | LSP 客户端 | `client.ts`（JSON-RPC stdio + Content-Length 帧、didOpen/didChange 全文同步、push 诊断新鲜度判定）、`servers.ts`（内置服务器默认表 + rootMarkers/二进制解析）、`manager.ts`（按 `name:workspaceRoot` 缓存客户端、idle 回收） |
| `kanban/` | 看板状态存储 | `store.ts`（列/卡片/回收站软删） |
| `update/` | 版本检查与热更新 | `scheduler.ts`、`updater.ts`、`snapshot.ts`、`ipc.ts`（新旧实例握手） |
| `shared/` | 前后端共享 | `types/`（REST DTO）、`utils/`（`errorMessage` 等）、`permissions.ts`、`usage.ts` |
| `web/` | React 前端 | `App.tsx`、`routes.tsx`（类型化路由表）、`views/`（页面）、`components/`、`services/`（HTTP 层）、`hooks/`、`composer/`、`styles/` |

## 测试布局

- 测试文件与被测代码**同目录**，命名 `*.test.ts` / `*.test.tsx`；不建 `tests/` 汇总目录。
- vitest 双 project（`vitest.config.ts`）：`node`（排除 `src/web/**`）与 `web`（happy-dom + `src/web/test-setup.ts`）。
- 跑法：增量 `pnpm test -- --changed`、单文件 `pnpm test -- <路径>`、监听 `pnpm test:watch`；全量并发上限与顺序执行约定见 AGENTS.md §2。
- DB 测试共享 `src/db/test-utils.ts` 的单 PGLite 实例（每文件 boot 一次 + TRUNCATE 重置），顺序执行。
- 新 bug 的回归测试优先进已有 describe 块，不建补丁孤岛（AGENTS.md §11）。

## 提交工作流

`pnpm install` 的 `prepare` 脚本（simple-git-hooks）自动安装 git 钩子；提交时 pre-commit 会经 lint-staged 对暂存的 `*.{ts,tsx,json}` 运行 `biome check --staged --write`（自动修复后入暂存）。确需跳过时用 `SKIP_SIMPLE_GIT_HOOKS=1 git commit …`。

## 前端要点

- 路径别名 `@/` → `src/web`、`@shared/` → `src/shared`，三处配置保持一致：`vite.config.ts`、`vitest.config.ts`、`src/web/tsconfig.json`。
- 路由：`@native-router`，类型化路由表在 `src/web/routes.tsx`（页面组件在 `views/`：ChatPage / KanbanPage / SettingsPage / RootRedirect 等，共享横幅与回收站树在 `views/_shared/`）；命令式导航走 `src/web/navigateTo.ts`。
- 数据层：`@tanstack/react-query`；HTTP 管道在 `src/web/services/api.ts`（fetch-fun：超时/重试/认证），各域 service（session/config/kanban…）均经它走 REST，类型尽量 re-export `@shared/types` 而非手抄。
- 控件层：haze-ui + react-use-control 受控包装（`SyncedInput` / `SyncedSelect` / `SyncedTextarea`）；haze 控件的 `value` 非受控语义与原生控件不同，外部改值需 `key={value}` 重挂载（详见 biome.json `inputComponents` 与组件内注释）。
- 样式统一 linaria（`import { css } from '@linaria/core'`）；编译器是 `@wyw-in-js/vite`（`@linaria/vite@5` 是废弃架构，与 vite 8 不兼容）。共享样式片段的插值边界与产物验证方法见 AGENTS.md §4。
- 全局状态在 `src/web/contexts/`（Config / Theme / FileSelection / Reference），不引入额外状态库。
- PWA 由 `vite-plugin-pwa` 提供（`src/web/dev-dist` 为开发期 SW 产物）。

## 数据库与 drizzle 迁移

- schema 唯一源：`src/db/schema.ts`；迁移只能 `pnpm db:generate` 生成到 `drizzle/*.sql`（禁止手改，AGENTS.md §1）。
- 运行时 `src/db/migrate.ts` 在启动时自动应用迁移；`src/db/client.ts` 创建 PGLite（PostgreSQL WASM）连接，数据目录由 `C0DE_DB_DIR` 或全局默认路径解析（`server.ts` 的 `resolveDbDir`）。
- 表布局（`schema.ts`）：`projects`（项目注册）、`sessions` + `session_entries`（会话与消息/工具条目）、`compaction_archives` + `file_snapshots`（压缩归档与文件快照）、`tool_metrics`（工具耗时）、`kanban_boards` + `kanban_cards`（看板）、`usage_events`（用量账本，append-only）、`app_meta`（迁移与元信息）。
- PGLite 单写者：serve 与 CLI 不能同时写库（CLI 侧显式拒绝并提示）。

## 代码风格

- data + functions 范式：不写 class（core/server 无非测试 class）；类型用 `type` 不用 `interface`；判别联合用 `_tag` 字段（如 `src/core/types.ts` 的 `AgentEvent`）。
- 函数 ctx-first（依赖经 context 对象注入，如路由工厂的 `ServerContext` / 主循环的 `LoopDeps`）；类型导入用 `import type`。
- 错误消息提取统一 `errorMessage`（`src/shared/utils/string.ts`），不要手写 `err instanceof Error ? err.message : String(err)`。

## 热更新流程

`src/update/` 两阶段（细节与约定见 AGENTS.md §8）：

1. **install**：`scheduler.ts` 后台定期检查新版本；`updater.ts` 识别安装方式（npm/pnpm；unknown 则等用户手动更新）并自动安装——失败不触碰任何会话状态。
2. **handoff**：安装成功后序列化会话快照（`snapshot.ts`），detached spawn 新实例 `serve --restore <快照> --handoff-port <端口>`；新实例经 `ipc.ts` 携 Bearer token 请求旧实例 graceful shutdown、接管端口。空闲会话零感知；进行中对话会中断并在界面提供重发。

## 常见改动落点

- **加 REST 端点**：`src/shared/types/` 定义 DTO → `src/server/routes/<域>.ts` 新建/扩展路由工厂 → `server/app.ts` 挂载 → 前端 `src/web/services/<域>.ts` 调用（类型 re-export shared，勿手抄）。
- **加内置工具**：`src/tools/builtin/<name>.ts` 实现 → `tools/registry.ts` 注册（启用语义走 `resolveEnabledToolNames`，AGENTS.md §6）→ 需要确认的工具在 `tools/permission.ts` 声明等级。
- **加配置键**：`src/core/config.ts`（默认值 + `KNOWN_CONFIG_KEYS`）；若属服务端全局参数，同步 `stripProjectServerKeys`（AGENTS.md §7）；前端设置页在 `src/web/views/Settings.tsx`。
- **加斜杠命令**：`src/core/slash.ts`（Web 与 CLI 共用同一实现）。
- **加子 agent 类型**：`src/core/agents/builtin.ts` 定义 + `registry.ts` 注册。
- **改 schema**：只改 `src/db/schema.ts` → `pnpm db:generate` 生成迁移（AGENTS.md §1），勿手写 `drizzle/*.sql`。
- **改系统提示词分片**：改 `src/core/prompts/<分片id>.md` → `pnpm gen:prompts`（禁手改 `prompts.generated.ts`，AGENTS.md §12）。
- **更新模型价目目录**：`pnpm gen:models` 从 models.dev 拉取重生成（`-- --date=YYYY-MM-DD` 固定日期可复现）；解析链与 provider 别名表在 `src/llm/model-catalog.ts`。

