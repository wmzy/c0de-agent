# AGENTS.md

本仓库是 **c0de-agent**——开源 AI 编码助手，Browser-Server 架构（Hono + SSE 后端 / React 前端 / PGLite 本地数据库 / CLI）。架构导览与代码阅读入门见 [DEVELOPMENT.md](./DEVELOPMENT.md)，产品行为详见 [README.md](./README.md)。本文件是贡献者与 coding agent 共同遵守的仓库级约定，每条均以当前代码库为核实基准。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 开发服务器（vite 单端口 3020，前端热更新 + `/api` 后端中间件） |
| `pnpm typecheck` | 后端类型检查（`tsc --noEmit`） |
| `pnpm typecheck:web` | 前端类型检查（`src/web/tsconfig.json`） |
| `pnpm test` | 全量测试（`vitest run`；并发已限 4 worker，见下） |
| `pnpm lint` | `biome check src/`（lint 规则 + 格式化差异） |
| `pnpm format` | `biome format --write src/` |
| `pnpm build` | 编译 CLI/后端到 `dist/` |
| `pnpm build:web` | 构建前端到 `dist-web/` |
| `pnpm db:generate` | 从 `src/db/schema.ts` 生成 drizzle 迁移 |
| `pnpm db:studio` | drizzle-kit studio 查看数据库 |
| `pnpm gen:prompts` | 从 `src/core/prompts/*.md` 重新生成系统提示词分片（`prompts.generated.ts`） |
| `pnpm gen:models` | 从 models.dev 重新生成模型价目目录（`-- --date=YYYY-MM-DD` 可固定日期复现） |

测试策略：日常一律跑增量 `pnpm test -- --changed`；全量 `pnpm test` 留给提交前与 CI。

## 硬性约定

### 1. drizzle 迁移禁止手写

`drizzle/*.sql` 只能由 `pnpm db:generate`（`drizzle-kit generate`，配置见 `drizzle.config.ts`：schema `./src/db/schema.ts`、输出 `./drizzle`）生成。禁止手写或手改迁移 SQL——改 schema 后重新 generate。

### 2. PGLite 单写者与测试并发

PGLite（WASM）是单写者数据库，全仓共享一个数据目录。两条推论：

- DB 相关测试共享 `src/db/test-utils.ts` 的单实例（每文件 boot 一次 + TRUNCATE 重置），必须顺序执行，不要在用例内自建并发 PGLite；
- vitest 两个 project 均已设 `maxWorkers: 4`（`vitest.config.ts`）——这是 WASM 并发加载的稳定性上限（更高并发会触发 "Worker exited unexpectedly" worker 崩溃），**勿调高**。

同理：`c0de serve` 运行期间，`c0de chat` / `c0de sessions` 等 CLI 命令会因数据库被占用而拒绝执行——这是单写者设计而非 bug。

### 3. biome：unsafe fix 勿盲施

`pnpm lint`（biome check）同时校验 lint 规则与格式化差异，CI 把两者都当 error（`.github/workflows/ci.yml`）。格式问题用 `pnpm format` 修；`biome check --fix --unsafe` 可能破坏 TypeScript 类型收窄（narrowing），只应逐处审阅后施用。

### 4. linaria 片段插值的边界

`css\`\`` 模板内插值 CSS 片段仅在两种形态下安全：**纯声明**（只有顶层声明）或**纯嵌套**（只有 `&:pseudo {}` 块）。「顶层声明 + 嵌套块混排」的片段会静默破坏解析——片段自身与其后模板里的嵌套块全部丢失、产出畸形规则；类名插值（`${someClass};`）则是静默 no-op。改动共享样式片段后，用 `pnpm build:web -- --minify false` 检查产物 CSS 是否完整（linaria 哈希类名无法按名 grep，按规则体反查）。

### 5. vite 8 的 .env 与 dev 端口

vite 8 不再把 `.env` 合并进 `process.env`（只进 `import.meta.env`）；而后端经 ssrLoadModule 在 vite 进程内运行、只读 `process.env`，因此 `vite.config.ts` 的 honoApiPlugin 手动注入 `C0DE_*`（开发隔离变量 `C0DE_DB_DIR` / `C0DE_CONFIG_DIR`）。给后端新增环境变量时同步改这里。dev 端口配置为 3020 但**未固定**（无 strictPort，被占用时 vite 自动递增），脚本勿硬编码端口号，用 curl 探测实际端口。

### 6. fail-closed 的启用语义

`tools.enabled` 与 `slashCommands.enabled` 统一 fail-closed：`['*']` = 全部（缺省）、显式名单 = 仅名单内、**空数组 `[]` = 全部禁用**（不是旧版「空 = 全部启用」）。解析统一走 `resolveEnabledToolNames`（`src/core/config.ts`）。改工具/命令启用逻辑时勿引入第三种口径。

### 7. security.* 只在全局作用域生效

`security.*`（authEnabled / token / allowedOrigins 等）是服务端全局参数：项目作用域 `.c0de/config.json` 加载时由 `stripProjectServerKeys`（`src/core/config.ts`）整体剥离，项目配置无法影响鉴权与 CORS。新增服务端全局键时必须同步加进剥离清单，否则信任边界出现缺口。

### 8. 热更新两阶段与认证 token 优先级

热更新分两阶段（`src/update/updater.ts` / `ipc.ts`）：**install**——后台安装新版本，安装失败不触碰任何会话状态；**handoff**——安装成功后序列化会话快照、detached spawn 新实例（`serve --restore <快照> --handoff-port <端口>`），由新实例经 IPC 请求旧实例 graceful shutdown 并接管端口。改动更新链路时保持「先安装、后动会话」的顺序。

认证 token 解析优先级（`src/server/server.ts` 的 `resolveAuthToken`）：`security.token` > 环境变量 `C0DE_AUTH_TOKEN` > 数据目录 auth-token 文件（已有注册设备时复用）> 自动生成并落盘。

### 9. 项目信任指纹的覆盖面

信任指纹（`computeProjectRiskFingerprint`，`src/project/trust.ts`）= 风险配置键 canonical 行 + MCP 服务器全参数（name+command+args+transport+url）+ `.c0de/plugins` 目录全部文件内容 hash + `.c0de/workflows` 目录文件内容 hash + `.c0de/rules` 流规则文件内容 hash（后三者防「同名改代码/改 args/改规则条件」绕过复检）。任何新增「仓库自带可执行内容」的机制都必须纳入指纹口径，否则信任边界出现静默缺口。

### 10. TS 源码一律 .js 后缀 ESM 导入

`type: module` 项目，TS 模块之间的 import 一律带 `.js` 后缀（包括 `.tsx` 文件：`from '@/components/TerminalPanel.js'`）。新增文件保持一致，否则 `tsc --noEmit` 与 Node 运行时都会挂。

### 11. 测试放置

新 bug 的回归测试优先归入**已有**测试文件的 describe 块，不建补丁测试孤岛；只有新命令/新模块/新行为才新建测试文件。

### 12. 生成文件禁止手改

`*.generated.ts`（`src/core/prompts.generated.ts`、`src/llm/model-catalog.generated.ts`）是生成器产物，已在 `biome.json` 排除检查：改系统提示词分片请改 `src/core/prompts/*.md` 后跑 `pnpm gen:prompts`；改价目目录请改生成器 `scripts/gen-models.mjs` 后跑 `pnpm gen:models`（生成器输出必须确定性：排序键、定宽渲染）。

### 13. 服务侧日志走 core/logger

后台诊断与 best-effort catch 的日志统一用 `src/core/logger.ts` 的 `getLogger(namespace)`（JSONL 按日落盘轮转至 `<数据目录>/logs/`，`C0DE_LOG_LEVEL` 控级别，warn/error 回显 stderr），不要新增 `console.*`。例外是**有意的用户面输出**：serve 启动横幅/URL/token 指引、CLI 交互提示。`src/web/` 不得 import `src/core/`（logger 带 node:fs，进了 web 包就炸浏览器端），前端保持只依赖 `@shared`。
