# c0de-agent 项目分析报告

> 分析时间：2026-09-16
> 基线：产品逻辑审查批次（信任边界代码面、配置语义统一、CLI 回收站闭环、websearch 降级、更新影响面、配对防误批）
> 本轮：工作流三通道同口径修复（预算/URL 注册表/agentManager 生命周期）、超时真中止、临时会话移入回收站、CLI 预算覆盖 abort 语义、回收站 --project 作用域、glob 双星号、REST 创建工作流 target/projectId 校验、前端工作流进度横幅
> 本轮（续）：权限挂起请求按用户可见会话归属（reportSessionId）、Web 设置页工作流管理面板（查看/新建/编辑/删除）、DELETE ?projectId 按路径删除、CLI deleted 全库口径提示

---

## 一、项目概览

**c0de-agent** 是一个开源 AI 编码助手，采用 Browser-Server 架构。

| 维度 | 现状 |
|------|------|
| 语言 | TypeScript (Node 22+) |
| 后端 | Hono + SSE + Drizzle ORM + PGLite |
| 前端 | React 19 + Vite 8 + Linaria CSS-in-JS |
| 测试 | Vitest（node + web 双 project，2361 用例；node project 限 4 worker） |
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
| 工作流执行 | 三通道同口径：Web 斜杠 `/workflow run` 走专用通道（与 REST `POST /api/workflows/:name/run` 一致——预算护栏、urlRegistry/hookRunner、agentManager 注册 + 断连 abort、进度 SSE、主 run 活跃时 409 RUN_ACTIVE 并发守卫）；CLI 经 buildAgentDeps 统一注入 budgetAbort。`meta.timeout` 超时**真正中止**父 agent（abort 级联子 agent），不再只报错后后台续跑。运行会话标题带时间戳（`workflow:<name> MM-DD HH:mm`），多次运行在会话树可区分。REST 创建必填 `target`（project 或 user），`target=project + projectId` 须项目已信任（409 TRUST_REQUIRED）且落盘该 project worktree；斜杠 `/workflow create` 覆盖同名需 `--yes`。前端消费 `progress` 事件以横幅展示执行阶段。**管理入口**：设置页「工作流」面板（列表/查看源码/新建/编辑/删除——删除需输入名称确认，`DELETE ?projectId` 按路径删文件、不执行仓库代码故无信任门禁，且不误删 user 级同名注册表条目） |
| 配置语义 | `tools.enabled` 与 `slashCommands.enabled` 统一 fail-closed（`['*']`=全部、`[]`=全禁），迁移告警引导 |
| 会话回收站 | 60 天（首次看到起算）+ 365 天绝对上限 + 7 天宽限；批次对称恢复；CLI 闭环：`deleted` 列出即标记 seen（`--project <path>` 限定作用域，与 Web 分组同口径）、`purge <id>/--all --yes` 彻底删除；**临时会话（print/workflow）30 天到期移入回收站而非物理删除**——可见子 agent 会话同样享有可恢复承诺 |
| 用量预算 | 金额 + token 双口径，warn/pause/abort；账本查询失败按动作 fail-open/fail-closed；导入调用剥离 callId 不进账本 |
| 权限 | 双层超时（5min 提示 + 25min 宽限），timeoutAction=pause 默认；**挂起请求按「发起 run 的用户可见会话」归属**（reportSessionId）——子 agent 的 ask 请求不再挂各自子会话，刷新/切页后从主/工作流会话即可重挂弹窗 |
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
