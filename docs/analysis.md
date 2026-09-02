# c0de-agent 项目分析报告

> 分析时间：2026-09-02
> 版本：0.1.0
> 基线：main @ 58c02eb（含本报告同期代码质量批次）

---

## 一、项目概览

**c0de-agent** 是一个开源 AI 编程助手，采用 Browser-Server 架构。核心是一个基于 LLM 的 agent loop，支持工具调用、子 agent 委派、git worktree 隔离、compaction 压缩、todo 标签协议、看板等能力。

| 维度 | 现状 |
|------|------|
| 语言 | TypeScript (Node 22+) |
| 后端 | Hono + Drizzle ORM + PGLite |
| 前端 | React 19 + Vite 8 + Linaria CSS-in-JS |
| 测试 | Vitest（node + web 双 project，205 文件 1947 用例） |
| Lint | Biome 2.x（check 同时校验格式） |
| 包管理 | pnpm（allowBuilds 授权 node-pty/esbuild） |

## 二、当前质量基线（实测）

| 项 | 结果 |
|------|------|
| `pnpm typecheck` | ✅ 0 错误 |
| `pnpm typecheck:web` | ✅ 0 错误 |
| `pnpm lint` | ✅ 0 诊断（2026-09-02 批次清零） |
| `pnpm test` | ✅ 1947 用例全过（node 153 文件 / web 52 文件；vitest 并发已限 4 worker） |
| CI | lint + 双端 typecheck + 测试 + build，全绿 |

## 三、历史问题闭环清单（2026-04 报告 → 现状）

| 当时问题 | 现状 |
|------|------|
| P0 web 测试全部失败（WYW transform） | ✅ 已修：vite 配置迁移至 @wyw-in-js/vite |
| P1 biome 格式错误 | ✅ 已修：format 全量清零 |
| P2 agentLoop 350 行过长 | ✅ 已拆：`src/core/loop/`（segment/persist/compaction/stream-collect/subagent/todo） |
| P2 CLI dispatch 过重 + chat/acp DB 生命周期重复 | ✅ 已修：提取 `withAgentDeps`，dispatch 改用 `parseCommand` |
| P2 parser.ts 的 parseCommand 未被使用 | ✅ 已修：dispatch 统一走 parseCommand |
| P3 token 预算硬编码 128K | ✅ 已修：按 provider contextWindow 动态解析 + 缓存 |
| P3 autoApproveChecker 过于宽松 | ✅ 已修：safe（默认，只读放行）/ full-auto（非交互模式）双策略 |
| P3 静默 catch 无日志 | ✅ 已修：loop 告警走 `[loop]` 前缀日志 |
| SSE 流异常路径缺 done 事件 | ✅ 已修：catch/finally 双保险补发 done（`chat-finally.test.ts` 专门回归） |
| compaction 默认窗口 8K | ✅ 已修：动态预算 + fallback 32K |
| 权限确认 404 | ✅ 已修：pending 存入全局 PermissionStore，按 toolCallId 寻址 |

## 四、2026-09-02 批次改进（本报告同步提交）

1. **仓库卫生**：删除误提交的根目录杂散文件 `验证`；删除空壳模块 `src/mcp/`（无任何引用）。
2. **CI**：增加 `typecheck:web` step；Lint step 明确覆盖格式校验（biome check 把格式差异按 error 处理）。
3. **测试稳定性**：16 核机器上 vitest 默认全并行 forks，PGLite（WASM）并发加载偶发 worker 崩溃（复现：首轮 2 个 worker 挂掉）。已在 vitest.config 将 node/web 两 project 限制 `maxWorkers: 4`。
4. **代码质量**：biome 全部诊断清零（含 a11y：TerminalPanel 标签页/分隔条补齐键盘与 ARIA、TodoPanel 任务行改真按钮、Chat 视图切换改 section、ModelSelector effect 依赖修复等）；CLI dispatch 统一 parseCommand 并提取 withAgentDeps。
5. **文档**：README 架构段补全 db/project/kanban/dap/plugins 等目录。

## 五、已知限制（未修复，按设计取舍）

- 推送通知未实现（README 特性列表未承诺）。
- PGLite 并发写入有上限：多进程同时写同一 DB 仍可能冲突（本地单进程场景无影响）。
- `session/` 下部分测试标记 pending（3 个用例），属主动跳过。
- 远程访问需用户自行配置 `config.security.token`（默认仅放行本地回环 origin）。

## 六、维护约定

- 新 bug 测试优先归入已有 describe，不建补丁测试孤岛。
- PGLite 相关测试文件不并行跑（vitest node project 已限 4 worker，仍不要提高）。
- biome check 即 CI 门禁：提交前跑 `pnpm format && pnpm lint`。
- 前端样式统一 linaria；组件类名不复用原生语义（原生 button 需在样式里重置）。
