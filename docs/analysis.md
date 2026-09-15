# c0de-agent 项目分析报告

> 分析时间：2026-09-15
> 基线：产品逻辑审查批次（信任边界代码面、配置语义统一、CLI 回收站闭环、websearch 降级、更新影响面、配对防误批）

---

## 一、项目概览

**c0de-agent** 是一个开源 AI 编码助手，采用 Browser-Server 架构。

| 维度 | 现状 |
|------|------|
| 语言 | TypeScript (Node 22+) |
| 后端 | Hono + SSE + Drizzle ORM + PGLite |
| 前端 | React 19 + Vite 8 + Linaria CSS-in-JS |
| 测试 | Vitest（node + web 双 project，约 2100+ 用例；node project 限 4 worker） |
| Lint | Biome 2.x（check 同时校验格式） |
| 包管理 | pnpm |

## 二、质量基线（实测）

| 项 | 结果 |
|------|------|
| `pnpm typecheck` | ✅ 0 错误 |
| `pnpm typecheck:web` | ✅ 0 错误 |
| `pnpm lint` | ✅ 0 诊断 |
| `pnpm test` | ✅ 全量通过（ECONNREFUSED:3000 与 snapshot PGLite 并发为预存噪音） |

## 三、核心产品机制（2026-09-15 批次确认/落地）

| 领域 | 机制 |
|------|------|
| 信任边界 | 风险配置指纹 = 风险键 + MCP 完整参数 + 插件/**工作流**文件内容 hash（`.c0de/workflows/*.js` 与插件同为仓库自带任意代码执行面，纯文件系统检测）；漂移复检含插件/工作流代码、MCP args；聊天门禁与 serve 启动插件/工作流加载同口径（漂移即不加载）；CLI `c0de trust` 展示风险清单并要求 `--yes`；用户经 REST/斜杠新建工作流后自动刷新指纹（防「信任→新建→自锁复检」） |
| 工作流执行 | REST `POST /api/workflows/:name/run` 与 chat 斜杠路径对齐：信任门禁（409 TRUST_REQUIRED）、交互式权限（SSE + 全局 store）、预算护栏注入、会话绑定 projectId/worktreePath；同名覆盖内置工作流在 UI 明示「覆盖内置」徽标 |
| 配置语义 | `tools.enabled` 与 `slashCommands.enabled` 统一 fail-closed（`['*']`=全部、`[]`=全禁），迁移告警引导 |
| 会话回收站 | 60 天（首次看到起算）+ 365 天绝对上限 + 7 天宽限；批次对称恢复；CLI 闭环：`deleted` 列出即标记 seen、`purge <id>/--all --yes` 彻底删除 |
| 用量预算 | 金额 + token 双口径，warn/pause/abort；账本查询失败按动作 fail-open/fail-closed；导入调用剥离 callId 不进账本 |
| 权限 | 双层超时（5min 提示 + 25min 宽限），timeoutAction=pause 默认 |
| 认证 | bootstrap 轮换 + 5min TTL；设备配对 6 位码审批（须输入码核对，服务端校验防误批）；token 交付时登记（无僵尸设备） |
| 热更新 | 先安装后暂停；失败零触碰；影响面确认列 run 运行态（正在执行工具的 run 超时强杀并明示）、终端、待确认权限数 |
| Websearch | auto 模式运行时降级链（tavily > brave > duckduckgo；401/403/429/5xx/网络错误换后端，400 不降级）；显式选择不降级 |

## 四、已知限制（按设计取舍）

- CLI 与 Web 共享单写者 PGLite：serve 运行期间 `c0de chat`/`sessions` 被拒（给出 Web 地址与 `--temp` 出口）。根治需 CLI 经 serve HTTP API 转发（设备 token 不在 CLI 侧，需先做 CLI 侧认证设计），暂缓。
- 本地数据无界增长：web/CLI 持久会话永不清理、`usage_events` append-only。无磁盘管理面板，低优先级。
- 推送通知未实现（README 未承诺）。
- 远程访问需显式配置（`--host 0.0.0.0` + `security.allowedOrigins`/token）。

## 五、维护约定

- 新 bug 测试优先归入已有 describe，不建补丁测试孤岛；新命令/新行为才新建测试文件。
- PGLite 相关测试文件不并行跑（vitest node project 已限 4 worker，仍不要提高）。
- biome check 即 CI 门禁：提交前跑 `pnpm format && pnpm lint`。
- 前端样式统一 linaria。
- drizzle 迁移用 `db:generate`，勿手写 SQL。
