# c0de-agent 设计规格对比分析：可借鉴功能点

> 生成日期：2026-06-25（第二轮深度分析）
> 参考项目：pi, opencode, oh-my-pi, oh-my-openagent, painless, anthology
> 分析方法：12 个并行 agent 分别研究不同模块（6 个初始 + 6 个深度）
> 总计：209 个可借鉴功能点（初始 123 + 深度新增 86）

---

## 1. Agent Loop + Core（18 个借鉴点）

### 1.1 Agent Loop 核心循环

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 1 | **协作式中断（Cooperative vs Immediate）** | pi | P0 | 当前暂停语义不够精确：`break` 会跳过整个 chunk 处理。改为协作式：在每个处理步骤间检查暂停信号，确保当前 chunk 完整处理后再暂停 |
| 2 | **渐进式 Token 预算截断** | pi | P0 | 防止 prompt 溢出：先截断大输出，再截断中间消息，最后才截断最近消息。避免一刀切丢弃 |
| 3 | **Doom Loop 渐进升级** | oh-my-openagent | P1 | agent 重复失败时渐进升级策略：第一次重试 → 换模型 → 注入反模式提示 → 强制停止 |
| 4 | **Event Stream 协议标准化** | pi | P1 | 生命周期事件标准化：`agent_start → turn_start → message_start → message_update → message_end → tool_execution_start/end → turn_end → agent_end` |

### 1.2 暂停/恢复

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 5 | **PendingToolCall 暂停点** | oh-my-pi | P0 | 暂停时记录 `pendingToolCall`（哪个工具正在执行、输入是什么），恢复时可选择跳过或重试 |
| 6 | **PauseReason 语义化** | pi | P1 | 暂停原因区分：`user_request` / `permission_required` / `compaction_in_progress` / `error_recovery`，前端据此展示不同 UI |

### 1.3 Steering 消息

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 7 | **Steering 消息类型区分** | oh-my-openagent | P1 | 区分 `correction`（纠正当前行为）和 `injection`（注入新上下文），LLM 处理方式不同 |
| 8 | **Steering 消息历史追溯** | pi | P2 | 记录每条 steering 消息及其影响的 turn，方便调试 |

### 1.4 Prompt 构建

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 9 | **System/Message Prompt 分离变换** | opencode | P0 | `system.transform` 和 `messages.transform` 分开，避免脆弱的遍历 messages 找 system message |
| 10 | **Keyword Detector 动态模式切换** | oh-my-openagent | P1 | 自然语言触发模式切换：检测 "debug"/"refactor" 等关键词，自动注入对应 prompt section |
| 11 | **Prompt Section 优先级排序 + 条件渲染** | opencode | P1 | 已有设计但需加强：按 token 预算动态裁剪低优先级 section |

### 1.5 Slash 命令

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 12 | **自定义 Slash 命令注册** | oh-my-pi | P1 | 插件可注册自定义命令，通过 PluginManifest 声明 |
| 13 | **命令参数自动补全** | opencode | P2 | 前端输入 `/` 时显示可用命令列表 + 参数提示 |

### 1.6 URL Scheme

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 14 | **URL Resolver 缓存** | opencode | P1 | 对 `agent://`、`pr://` 等远程资源做短期缓存，避免重复网络请求 |
| 15 | **URL Scheme 扩展注册** | oh-my-openagent | P2 | 插件可注册自定义 URL scheme（如 `mcp://server/tool`） |

---

## 2. LLM Provider + MCP（18 个借鉴点）

### 2.1 Provider 抽象与路由

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 1 | **单一来源 ProviderDefinition 注册表** | oh-my-pi | P0 | 添加 provider = 一个文件 + 一行注册，零配置自动发现 |
| 2 | **Provider 工厂懒加载** | pi | P1 | 按需加载 provider 实现，支持 tree-shaking，减少启动时间 |
| 3 | **Protocol 复用（OpenAI Compat 共享）** | opencode | P1 | DeepSeek/Groq/Together 共享 `OpenAIChat.protocol`，无需复制实现 |

### 2.2 缓存策略

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 4 | **Cache-Policy Auto-Placement** | opencode | P0 | 自动在 tools/system/最新 user message 三处放置缓存断点，遵守 Anthropic 4 断点上限 |
| 5 | **多源模型目录缓存分层** | oh-my-pi | P1 | `static → models.dev → cache → dynamic`，区分 authoritative/non-authoritative |
| 6 | **Provider 特定缓存语义抽象** | opencode | P1 | Anthropic 显式标记 / OpenAI 隐式 / Gemini out-of-band，上层无需关心细节 |

### 2.3 Fallback 与重试

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 7 | **会话级 Fallback Chain + 角色绑定** | oh-my-pi | P0 | 每个 role 独立 fallback chain + 冷却窗口抑制 |
| 8 | **Context Promotion** | oh-my-pi | P2 | 超长上下文先升级模型（如 128K→200K）再压缩 |
| 9 | **fallbackRevertPolicy** | oh-my-pi | P1 | Fallback 到新 provider 后，是否回退到原 provider 的策略配置 |

### 2.4 角色路由

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 10 | **route.with() 模型级 Route 变体** | opencode | P1 | 路由可基于运行时条件动态选择模型 |
| 11 | **跨 Provider Handoff** | pi | P2 | 自动转换 thinking blocks（如 Anthropic → OpenAI） |

### 2.5 MCP 集成

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 12 | **MCP server 作为 Route endpoint** | opencode | P1 | MCP server 复用 Protocol/Transport 框架 |
| 13 | **MCP Server 运行时动态发现与热重载** | oh-my-pi | P2 | 插件可动态注册 MCP server |
| 14 | **MCP 工具命名空间隔离** | opencode | P1 | `server__tool` 格式避免工具名冲突 |

### 2.6 模型能力管理

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 15 | **多源动态模型发现** | oh-my-pi | P1 | `bundled → models.dev → cache → dynamic` |
| 16 | **自动模型发现 + 内置 token/cost tracking** | pi | P1 | 无需手动注册模型能力 |
| 17 | **模型能力从 Provider 元数据自动派生** | opencode | P2 | 运行时从 API 响应推断能力 |

---

## 3. Plugin & Hook（18 个借鉴点）

### 3.1 插件架构

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 1 | **tool() 工厂函数 + Zod Schema 验证** | opencode + oh-my-pi | P0 | 类型安全工具定义、运行时参数验证、名称冲突处理 |
| 2 | **声明式 PluginManifest + 版本兼容检查** | oh-my-pi | P1 | 插件依赖解析、冲突检测、设置 UI 自动生成 |
| 3 | **PluginManager + Doctor 健康检查** | oh-my-pi | P2 | 运行时 install/uninstall、enable/disable、快照回滚 |

### 3.2 Hook 系统

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 4 | **Hook 执行语义：first-block / last-writer / chained** | oh-my-pi | P0 | `tool:before` 可真正阻止执行，`tool:after` 支持 last-writer-wins |
| 5 | **Hook 优先级排序 + 错误隔离** | oh-my-openagent | P1 | 单个 hook 失败不影响其他，按 priority 排序 |
| 6 | **Hook 超时 + 降级** | oh-my-pi | P1 | 超时自动跳过并记录警告，不阻塞主流程 |

### 3.3 内置 Hook

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 7 | **Session Recovery Hook** | oh-my-openagent | P1 | 会话错误恢复（thinking block 修改恢复、中断恢复） |
| 8 | **Preemptive Compaction** | oh-my-openagent | P1 | 在超限前主动压缩，而非等到溢出 |
| 9 | **Tool Pair Validator** | oh-my-openagent | P2 | 验证工具调用配对（如 read 必须在 edit 之前） |
| 10 | **Edit Error Recovery** | oh-my-openagent | P2 | 编辑错误自动恢复 |

### 3.4 工具工厂

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 11 | **工具优先级排序（LOW_PRIORITY_TOOL_ORDER）** | oh-my-openagent | P1 | 工具描述按优先级排序，减少 token 消耗 |
| 12 | **团队模式条件注册** | oh-my-openagent | P2 | 不同模式下注册不同工具集 |
| 13 | **工具输出智能截断** | oh-my-openagent | P1 | 按工具类型定制截断策略 |

### 3.5 动态 Prompt

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 14 | **Category Skill Reminder** | oh-my-openagent | P2 | 根据当前任务类别提醒相关技能 |
| 15 | **Plan Format Validator** | oh-my-openagent | P2 | 验证 agent 输出的计划格式 |
| 16 | **Think Mode 自动检测** | oh-my-openagent | P1 | 检测消息中的思考模式关键词，自动切换 |

### 3.6 插件生命周期

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 17 | **Extension Dispose 模式** | oh-my-pi | P1 | 扩展卸载时自动清理资源 |
| 18 | **Plugin 热重载** | oh-my-pi | P2 | 开发时插件修改后自动重新加载 |

---

## 4. Session & Compaction（24 个借鉴点）

### 4.1 Session 数据结构

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 1 | **Message/Part 双层数据模型** | pi | P0 | tool_call/tool_result 作为 Part 而非独立 Entry，更自然的嵌套 |
| 2 | **Provider-aware 数据类型标记** | oh-my-pi | P2 | model/provider 追溯，方便调试和成本分析 |
| 3 | **Session 结构化元数据字段** | opencode | P1 | compactionState, branchSource 等预定义字段 |

### 4.2 Compaction 策略

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 4 | **LLM 摘要 + previousSummary 级联** | pi | P0 | 避免信息雪崩：压缩时传入上次摘要作为参考 |
| 5 | **Overflow 裁剪 + PROTECTED_TOOLS** | opencode | P0 | 防 413 错误：保护最近的工具调用结果不被裁剪 |
| 6 | **本地确定性压缩（零网络调用）** | oh-my-pi | P1 | overflow 安全恢复：不依赖 LLM 的本地压缩 |
| 7 | **splitTurn 机制** | pi | P1 | turn 内切割：prefix 保留 + 分别摘要 |

### 4.3 安全切割点

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 8 | **findValidCutPoints + findCutPoint 双层算法** | pi | P0 | 禁止在 toolResult 处切割，确保 tool_call/tool_result 配对完整 |
| 9 | **previousCompaction boundaryStart/boundaryEnd** | pi | P1 | 增量压缩：只压缩新增部分 |
| 10 | **isOverflow 前置预判** | opencode | P1 | 考虑下一轮 system prompt + tool schemas 的预估 token |

### 4.4 分支管理

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 11 | **/tree 导航 + findCommonAncestor** | pi | P1 | 同一 session 内 leaf 移动，共同祖先查找 |
| 12 | **BranchSummary 包含 readFiles/modifiedFiles/decisions** | pi | P1 | 分支摘要更丰富 |
| 13 | **session_before_tree 事件钩子** | pi | P2 | 可取消/可注入自定义摘要 |

### 4.5 文件快照

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 14 | **Provider-aware 帧形状选择** | oh-my-pi | P2 | SnapCompact 不同 provider 不同渲染策略 |
| 15 | **fileOps 自动提取** | pi | P1 | 压缩准备阶段直接从 tool call 提取文件操作 |
| 16 | **File Snapshot 与 SnapCompact 联动** | oh-my-pi | P2 | preserveData 机制 |

### 4.6 压缩归档搜索

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 17 | **归档 summary 独立列 + 时间复合索引** | opencode | P1 | 游标分页高效查询 |
| 18 | **CompactionEntry 结构化字段（quality_score）** | pi | P2 | 压缩质量可查询 |
| 19 | **Autocontinue 机制** | opencode | P1 | 压缩后自动继续任务，无需用户干预 |

---

## 5. Tool System + AST + Hashline（21 个借鉴点）

### 5.1 工具注册与执行

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 1 | **ToolFactory 条件注册 + 优先级排序** | oh-my-openagent | P0 | 返回 null 表示不适用（如缺少依赖），优先级控制描述顺序 |
| 2 | **tool-definition-wrapper 统一处理** | pi | P1 | 输入验证、错误捕获、输出格式化统一包装 |
| 3 | **ToolResult 联合类型扩展** | pi | P1 | 支持 `text | image | error`，图片直接返回 base64 |

### 5.2 权限系统

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 4 | **批量权限确认** | opencode | P1 | 多个 ask 工具可一次确认 |
| 5 | **权限规则可配置化** | opencode | P1 | 用户可自定义哪些工具 auto/ask/deny |
| 6 | **权限记忆** | oh-my-openagent | P2 | 记住用户对特定工具的确认偏好 |

### 5.3 输出处理

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 7 | **智能截断（保留头尾 + 中间标记）** | opencode | P1 | 按行截断和按字符截断两种模式 |
| 8 | **bash 进程树 kill** | pi | P0 | 不只杀主进程，杀整个进程树 |
| 9 | **output-accumulator 累积器** | pi | P1 | 处理大输出截断，保留最近日志 |

### 5.4 Hashline 编辑

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 10 | **复用 oh-my-pi hashline 包** | oh-my-pi | P0 | 1800 行零依赖，已生产验证 |
| 11 | **Stale Anchor 检测 + 恢复** | oh-my-pi | P1 | 文件被修改后旧锚点失效的处理 |
| 12 | **Session-aware 3-way merge 恢复** | oh-my-pi | P2 | 编辑冲突时的智能合并 |

### 5.5 AST 工具

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 13 | **tree-sitter 增量解析** | opencode | P1 | 文件修改后只重新解析变化部分 |
| 14 | **AST 模式语法校验** | opencode | P2 | 执行前验证模式语法是否正确 |
| 15 | **多文件原子编辑** | opencode | P1 | 要么全部应用，要么全部回滚 |

### 5.6 DAP 集成

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 16 | **DAP 作为工具暴露** | 设计已有 | P0 | agent 自然使用调试能力 |
| 17 | **条件断点支持** | opencode | P1 | 断点可带条件表达式 |
| 18 | **变量监视** | opencode | P2 | watch 表达式自动更新 |

### 5.7 并行工具调用

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 19 | **写入冲突检测 + 串行化** | opencode | P0 | 操作同一文件的工具串行执行 |
| 20 | **工具调用配对验证** | oh-my-openagent | P2 | 确保 tool_call 和 tool_result 完整配对 |
| 21 | **并行度可配置** | oh-my-openagent | P2 | 用户可设置最大并行工具数 |

---

## 6. Web UI + Server + CLI（24 个借鉴点）

### 6.1 前端架构

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 1 | **TanStack Query 数据获取模式** | anthology | P0 | 缓存、重试、乐观更新统一管理 |
| 2 | **lazy 路由 + Suspense** | anthology | P1 | 代码分割，首屏加载 < 1s |
| 3 | **主题上下文 + 断点定义** | painless | P1 | @linaria CSS 变量 + 响应式断点 |

### 6.2 SSE 消费

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 4 | **SSE 重连 + 心跳** | opencode | P0 | 断线自动重连，心跳检测连接存活 |
| 5 | **SSE 事件解析器封装** | opencode | P1 | 统一的 SSE → AgentEvent 解析 |

### 6.3 代码高亮与 Markdown

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 6 | **Shiki 语法高亮** | opencode | P0 | 替代正则 tokenizer，支持 200+ 语言 |
| 7 | **marked + 自定义 renderer** | opencode | P1 | 代码块引用按钮、文件链接自动检测 |
| 8 | **Mermaid 图表渲染** | opencode | P2 | Markdown 中的 mermaid 代码块自动渲染 |

### 6.4 文件浏览器

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 9 | **Git 状态标记** | opencode | P1 | 文件树显示 modified/new/deleted 状态 |
| 10 | **文件搜索（名称 + 内容）** | opencode | P1 | 模糊搜索 + 内容搜索 |
| 11 | **文件变更 SSE 推送** | opencode | P2 | agent 修改文件后实时更新文件树 |

### 6.5 Server API

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 12 | **统一 SSE 端点** | opencode | P0 | `POST /api/chat` 一个端点返回所有事件 |
| 13 | **Agent 控制 REST API** | 设计已有 | P1 | abort/pause/resume/steer 通过 HTTP POST |
| 14 | **CORS 限制本地 origin** | anthology | P1 | 安全：只允许 localhost |

### 6.6 CLI 模式

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 15 | **ACP JSON-RPC 协议** | oh-my-pi | P0 | 编辑器集成标准协议 |
| 16 | **Print 模式流式输出** | opencode | P1 | 终端流式显示，不等完整响应 |
| 17 | **CLI 参数自动补全** | oh-my-pi | P2 | shell completion 脚本生成 |

### 6.7 热更新

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 18 | **端口接管 + IPC 通知** | 设计已有 | P1 | 新旧实例交接 |
| 19 | **SSE 自动重连** | opencode | P1 | 前端检测到连接断开后自动重连 |
| 20 | **Session 状态序列化/恢复** | opencode | P1 | JSONL 追加存储便于恢复 |

### 6.8 透明可观察

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 21 | **LLM 调用详情 Timeline** | 设计已有 | P1 | 按时间线展示每次调用 |
| 22 | **Token 用量 + 成本追踪** | pi | P1 | 自动计算每次调用成本 |
| 23 | **响应流回放** | opencode | P2 | 逐 chunk 查看响应过程 |
| 24 | **Cache Hit 可视化** | opencode | P2 | 显示缓存命中率 |

---

## 优先级汇总

### P0（立即实施，1-2 周）
1. 协作式中断修复暂停语义（Agent Loop）
2. Cache-Policy Auto-Placement（LLM Provider）
3. tool() 工厂函数 + Zod Schema 验证（Plugin）
4. findValidCutPoints 安全切割算法（Session Compaction）
5. LLM 摘要 + previousSummary 级联（Session Compaction）
6. bash 进程树 kill（Tool System）
7. 复用 oh-my-pi hashline 包（Tool System）
8. Shiki 语法高亮（Web UI）
9. SSE 重连 + 心跳（Web UI）
10. ACP JSON-RPC 协议（CLI）

### P1（1-2 个月）
1. Doom Loop 渐进升级
2. 会话级 Fallback Chain + 角色绑定
3. Hook 执行语义（first-block / last-writer）
4. Overflow 裁剪 + PROTECTED_TOOLS
5. SplitTurn 机制
6. 写入冲突检测 + 串行化
7. TanStack Query 数据获取
8. Git 状态标记
9. 统一 SSE 端点
10. 多源动态模型发现

### P2（2-3 个月）
1. Context Promotion
2. 跨 Provider Handoff
3. PluginManager + Doctor 健康检查
4. SnapCompact 位图压缩
5. 多文件原子编辑
6. Mermaid 图表渲染
7. 响应流回放
8. Cache Hit 可视化

---

## 实施路线图

```
Phase 1（Week 1-2）: P0 核心功能
├── Agent Loop: 协作式中断 + 渐进式截断
├── LLM: Cache-Policy Auto-Placement
├── Plugin: tool() 工厂 + Hook 语义
├── Session: 安全切割 + previousSummary
├── Tool: hashline 复用 + bash 进程树
└── Web: Shiki + SSE 重连

Phase 2（Week 3-6）: P1 增强功能
├── Agent Loop: Doom Loop + Event Stream
├── LLM: Fallback Chain + 角色绑定
├── Plugin: 内置 Hook + 工具工厂
├── Session: SplitTurn + Overflow 裁剪
├── Tool: 并行冲突检测 + 智能截断
└── Web: TanStack Query + Git 标记

Phase 3（Week 7-12）: P2 高级功能
├── LLM: Context Promotion + Handoff
├── Plugin: PluginManager + Doctor
├── Session: SnapCompact + 归档搜索
├── Tool: 多文件原子编辑 + AST 校验
└── Web: Mermaid + 响应回放
```

---

# 第二轮深度分析：新增 86 个借鉴点

> 基于 6 个并行 agent 对参考项目源码的逐行分析，与现有 123 个借鉴点交叉验证去重。
> 分析日期：2026-06-25

---

## 7. Agent Loop 深度补充（+10 个借鉴点）

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 16 | **Tool Result 类型边界强制规范化** | oh-my-pi | P0 | `coerceToolResult()` 在工具返回后强制校验 content 数组、block 类型、sanitize text，防止畸形数据污染消息历史 |
| 17 | **Session Revert 文件快照服务** | opencode | P0 | `SessionRevert` 提供 revert(messageID) + unrevert() + cleanup()，支持按 message 级别精确回退 + 反悔 |
| 18 | **Pending Session Writes 队列** | pi | P1 | turn 期间缓冲所有 session 写操作，turn 结束后批量 flush，保证事务性 |
| 19 | **Tool 并发模式声明** | oh-my-pi | P1 | `concurrency: shared | exclusive | fn`，工具自行声明并发行为，替代静态文件路径分析 |
| 20 | **Aside 消息队列（非中断注入）** | oh-my-pi | P1 | 区分 Steering（中断）、Aside（不中断，折叠到下轮）、Follow-up（触发继续）三种消息注入语义 |
| 21 | **Soft Tool Requirement 渐进强制** | oh-my-pi | P1 | 模型忽略必要工具时：提醒 → 跳过其他工具 → 强制 tool_choice → 放弃（3 次升级） |
| 22 | **Deadline 超时机制** | oh-my-pi | P1 | agent-loop 支持 deadline 配置，通过 AbortSignal.any() 实现全局超时终止 |
| 23 | **Provider Request Hook Chain** | pi | P1 | `before_provider_request` hook 链可修改请求、注入 header、替换 model |
| 24 | **Retry 响应头解析** | opencode | P1 | 从 `x-ratelimit-*` 和 `anthropic-ratelimit-*` 响应头提取精确重试时间 |
| 25 | **Tool Intent 追踪字段** | oh-my-pi | P2 | 在 tool call 中添加 intent 字段追踪工具调用目的，辅助行为分析 |

---

## 8. LLM Provider 深度补充（+7 个借鉴点）

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 18 | **Protocol Step State Machine** | opencode | P0 | `Protocol<Body,Frame,Event,State>` 的 State 参数贯穿 streaming pipeline，追踪内容块打开/关闭状态 |
| 19 | **共享 ToolStream 增量累加器** | opencode | P0 | 通用 `ToolStream` 处理工具调用 JSON 增量解析，消除 4 个 handler 中的重复累加逻辑 |
| 20 | **Lifecycle 事件追踪器** | opencode | P1 | 将原始 provider 事件映射为结构化生命周期事件序列，保证 start→delta→end 顺序 |
| 21 | **Framing 抽象层** | opencode | P1 | `Framing<Frame>` 接口分离字节流到帧的解码，支持 SSE 和 AWS event-stream |
| 22 | **Rate Limit Header 提取 + Secret Redaction** | opencode | P1 | 从 HTTP 响应头提取精确 rate limit 信息 + 两轮 secret 脱敏 |
| 23 | **Provider Compat Flags 系统** | pi | P0 | 17 个 compat flags（thinkingFormat 10 变体、cacheControlFormat 等）+ 自动检测 |
| 24 | **Diagnostic 注入机制** | pi | P2 | `AssistantMessageDiagnostic` 附加调试信息到消息，不泄露到 UI |

---

## 9. Plugin & Hook 深度补充（+12 个借鉴点）

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 19 | **Capability Registry 通用能力注册** | oh-my-pi | P0 | `defineCapability` + `registerProvider` 模式将"找什么"和"去哪找"解耦，支持优先级排序、去重 shadow |
| 20 | **Settings Schema + 自动 UI 生成** | oh-my-pi | P0 | `SETTINGS_SCHEMA` 声明式配置 + 类型推导 + 自动 UI 渲染，插件也有 PluginSettingSchema |
| 21 | **Tool Proxy 拦截器** | oh-my-pi | P0 | Proxy-based HookToolWrapper 透明代理工具属性，支持阻止 + 修改 + 进度流转发 |
| 22 | **Session Event Taxonomy** | oh-my-pi | P0 | 30+ 种事件类型（vs c0de 7 种），支持取消/阻止/修改/续写四种语义 |
| 23 | **Marketplace 插件市场** | oh-my-pi | P1 | 多源（GitHub/Git/URL/NPM）、原子写入、scope 感知、缓存管理 |
| 24 | **Hook Trust 完整性校验** | oh-my-openagent | P1 | SHA-256 哈希 hook 命令、验证目标文件存在、拒绝激活缺失目标插件 |
| 25 | **Extension Command 注册 + 参数补全** | oh-my-pi | P1 | 扩展注册 slash 命令 + getArgumentCompletions + ExtensionCommandContext |
| 26 | **Runtime Fallback 错误分类 + 自动降级** | oh-my-openagent | P1 | Session 级别模型降级 + 错误分类器 + per-session 降级链 + First Prompt Watchdog |
| 27 | **No-Progress Loop 检测** | oh-my-openagent | P1 | 检测 LLM 空转（token output=0）并自动停止循环 |
| 28 | **Legacy Compatibility Shim** | oh-my-pi | P2 | Bun.plugin() 拦截 import + 包别名重映射 + TypeBox→Zod shim |
| 29 | **Extension Dashboard** | oh-my-pi | P2 | 双列布局 + provider tab + 纯函数状态管理 |
| 30 | **Hook Input Component** | oh-my-pi | P2 | 带 CountdownTimer 的交互式提示组件，超时自动取消 |

---

## 10. Session & Compaction 深度补充（+13 个借鉴点）

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 20 | **Extension Hook 前置拦截系统** | pi | P0 | `session_before_compact` 事件可修改 preparation、取消压缩、替换整个压缩策略 |
| 21 | **Event-Sourced Session 架构** | opencode | P0 | 25+ 事件类型分为 Durable/Ephemeral，Projector 将事件流物化为 SQLite 表 |
| 22 | **Foveated Archive 多质量层归档** | oh-my-pi | P0 | 注视点归档：HQ→LQ→HQ 三级质量，中间最不重要的历史用更密集的帧 |
| 23 | **Session Context Epoch 版本化基线** | opencode | P1 | `revision` 字段实现 CAS 并发控制 + `baselineSeq` 标记 compaction 后起点 |
| 24 | **Incremental Summary Update** | pi | P1 | 增量更新已有摘要（UPDATE_SUMMARIZATION_PROMPT），保留之前摘要只添加新内容 |
| 25 | **Session Input Inbox Steering** | opencode | P1 | steer（立即中断）vs queue（等待完成）两种投递模式 + lseq 逻辑序列号 |
| 26 | **TurnTransition 状态机溢出恢复** | opencode | P1 | 状态机级别的 overflow 恢复策略 |
| 27 | **Per-Request Inline Imaging** | oh-my-pi | P1 | 逐请求帧化，不同 provider 不同渲染策略 |
| 28 | **Deferred Persistence** | pi | P2 | 首次输入不写文件，收到第一条 assistant 响应才创建文件 |
| 29 | **Savings Journal Token 节省追踪** | oh-my-pi | P2 | 追踪压缩节省的 token 数量 |
| 30 | **ScanRenderability 渲染可行性预检** | oh-my-pi | P2 | 预检内容是否适合渲染为图片 |
| 31 | **CompactMode 子命令多策略选择** | oh-my-pi | P2 | 多种压缩模式供用户选择 |
| 32 | **Session Fork 跨项目复制** | pi | P2 | 分支支持跨项目复制 |

---

## 11. Tool System 深度补充（+14 个借鉴点）

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 22 | **Tree-Sitter 语义化 Shell 解析权限检查** | opencode | P0 | tree-sitter-bash WASM 解析命令为 AST，提取文件路径参数做权限评估 |
| 23 | **Cascading Permission Reject** | opencode | P0 | 拒绝一个权限请求时自动拒绝同一 session 所有其他 pending 请求 |
| 24 | **Stream IO Grace Period** | pi | P0 | 进程退出后等待 stdout/stderr end 事件 + 100ms grace timer 防输出截断 |
| 25 | **Hashline Error Recovery 内联正确 Tag** | oh-my-openagent | P0 | hashline 不匹配时内联正确 tag 帮助模型修复 |
| 26 | **Multi-pass Fuzzy Edit 匹配策略链** | opencode | P1 | 5 层渐进匹配：精确→trim→空白归一→缩进弹性→Levenshtein（阈值 0.65） |
| 27 | **Post-Edit LSP 诊断回流** | opencode | P1 | 文件编辑后立即触发 LSP 诊断，错误信息回流给 agent |
| 28 | **Detached Child PID 追踪 + SIGHUP 清理** | pi | P1 | 全局子进程 PID 集合 + SIGHUP/SIGTERM 批量 kill |
| 29 | **Per-Realpath Mutation Queue** | pi | P1 | 按文件真实路径序列化写操作，支持跨文件并行 |
| 30 | **LRU SnapshotStore + SeenLines 防偏差** | oh-my-pi | P1 | 快照追踪 + seen-lines 机制防止编辑偏差 |
| 31 | **Replacement Boundary Repair + Delimiter Balance** | oh-my-pi | P1 | applyPatch 时修复边界 + 分隔符平衡检查 |
| 32 | **Pluggable Remote Execution Backend** | pi | P2 | 可插拔远程执行后端 |
| 33 | **Truncation Cleanup + Delegation Hint** | opencode | P2 | 截断文件清理 + 委派提示 |
| 34 | **Tool Description 作为结构化 Prompt** | oh-my-openagent | P2 | 工具描述包含 200 行工作流 |
| 35 | **Command Arity Dictionary** | opencode | P2 | 权限提示中包含命令摘要 |

---

## 12. Web UI 深度补充（+30 个借鉴点）

| # | 借鉴功能 | 来源 | 优先级 | 说明 |
|---|---------|------|--------|------|
| 25 | **Streaming Markdown Parser with Healing** | opencode | P0 | `remend` 库修复流式传输中不完整的 markdown 代码块 |
| 26 | **Web Worker 语法高亮队列** | opencode | P0 | Shiki 高亮在 Web Worker 中执行，队列自动淘汰过时请求 |
| 27 | **DOMPurify + morphdom 安全 DOM 更新** | opencode | P0 | sanitization + morphdom diff 替代 innerHTML |
| 28 | **Command Palette + 快捷键系统** | opencode | P0 | Cmd+Shift+P 命令面板，支持自定义快捷键 |
| 29 | **Auto-scroll 用户交互检测** | opencode | P0 | 流式输出时检测用户是否滚离底部 |
| 30 | **Session Context Metrics 可视化** | opencode | P1 | 按角色可视化上下文 token 分布 |
| 31 | **拖拽排序 Tabs** | opencode | P1 | 文件标签页支持 drag-and-drop 重排序 |
| 32 | **文件树懒加载** | opencode | P1 | 按需加载目录内容 + 文件类型图标 + Git 状态过滤 |
| 33 | **Session Diff Viewer** | opencode | P1 | 基于 patch 的文件变更 diff 渲染 |
| 34 | **文本动画组件** | opencode | P1 | Typewriter、TextReveal、TextShimmer 效果 |
| 35 | **Status Popover 健康状态** | opencode | P1 | 服务器/MCP 连接健康状态指示器 |
| 36 | **通知系统 + 未读追踪** | opencode | P1 | 按 session/project 索引的通知 + 未读计数 |
| 37 | **Todo Dock 进度可视化** | opencode | P1 | 实时 todo 完成进度条 + AnimatedNumber |
| 38 | **Followup Suggestions Dock** | opencode | P1 | AI 生成的后续建议问题 |
| 39 | **Revert Dock 撤销操作** | opencode | P1 | 工具执行结果的撤销/回滚面板 |
| 40 | **Question/Permission 交互 Dock** | opencode | P1 | 多选项权限确认 + 单选/多选交互 UI |
| 41 | **在外部应用中打开** | opencode | P1 | 支持 VS Code/Cursor/Zed/Terminal 等外部应用打开文件 |
| 42 | **Theme MutationObserver 同步** | anthology | P1 | 通过 DOM observer 同步外部主题变更 |
| 43 | **Route Preload Pattern** | anthology | P1 | defineRoute + preload 实现路由即时导航 |
| 44 | **Debug Bar 性能指标** | opencode | P2 | 开发模式下的 CLS/FID/LCP/内存使用叠加层 |
| 45 | **Route Prefetch Preview** | painless | P2 | 鼠标悬停时显示目标页面缩略预览 |
| 46 | **Loading 进度条（可取消）** | painless | P2 | NProgress 风格导航进度条 |
| 47 | **DevTool Mock Data 系统** | painless | P2 | JSON Schema Faker 生成假数据 |
| 48 | **Persist + LRU Cache** | opencode | P2 | 客户端持久化层 + LRU 淘汰 |
| 49 | **i18n 多语言系统** | opencode | P2 | 18 种语言的完整翻译系统 |
| 50 | **Context Menu 右键菜单** | opencode | P2 | 文件/消息的上下文操作菜单 |
| 51 | **HoverCard 悬停卡片** | opencode | P2 | 鼠标悬停显示详细信息卡片 |
| 52 | **Sticky Accordion Headers** | opencode | P2 | 可折叠区域的固定头部 |
| 53 | **Inline Editor 行内编辑** | opencode | P2 | 双击触发的行内重命名编辑器 |
| 54 | **Terminal Panel** | opencode | P2 | 基于 ghostty-web 的 Web 终端 |

---

## 第二轮深度分析：优先级汇总

### P0（立即实施，新增 21 个）
1. Tool Result 类型边界强制规范化（Agent Loop）
2. Session Revert 文件快照服务（Agent Loop）
3. Protocol Step State Machine（LLM Provider）
4. 共享 ToolStream 增量累加器（LLM Provider）
5. Provider Compat Flags 系统（LLM Provider）
6. Capability Registry 通用能力注册（Plugin）
7. Settings Schema + 自动 UI 生成（Plugin）
8. Tool Proxy 拦截器（Plugin）
9. Session Event Taxonomy（Plugin）
10. Extension Hook 前置拦截系统（Session）
11. Event-Sourced Session 架构（Session）
12. Foveated Archive 多质量层归档（Session）
13. Tree-Sitter 语义化 Shell 解析权限检查（Tool）
14. Cascading Permission Reject（Tool）
15. Stream IO Grace Period（Tool）
16. Hashline Error Recovery 内联正确 Tag（Tool）
17. Streaming Markdown Parser with Healing（Web UI）
18. Web Worker 语法高亮队列（Web UI）
19. DOMPurify + morphdom 安全 DOM 更新（Web UI）
20. Command Palette + 快捷键系统（Web UI）
21. Auto-scroll 用户交互检测（Web UI）

### P1（1-2 个月，新增 39 个）
1. Pending Session Writes 队列
2. Tool 并发模式声明
3. Aside 消息队列
4. Soft Tool Requirement 渐进强制
5. Deadline 超时机制
6. Provider Request Hook Chain
7. Retry 响应头解析
8. Lifecycle 事件追踪器
9. Framing 抽象层
10. Rate Limit Header 提取
11. Marketplace 插件市场
12. Hook Trust 完整性校验
13. Extension Command 注册
14. Runtime Fallback 错误分类
15. No-Progress Loop 检测
16. Session Context Epoch
17. Incremental Summary Update
18. Session Input Inbox Steering
19. TurnTransition 状态机溢出恢复
20. Per-Request Inline Imaging
21. Multi-pass Fuzzy Edit
22. Post-Edit LSP 诊断回流
23. Detached Child PID 追踪
24. Per-Realpath Mutation Queue
25. LRU SnapshotStore
26. Replacement Boundary Repair
27-39. Web UI P1（Session Context Metrics, 拖拽 Tabs, 文件树懒加载, Diff Viewer, 文本动画, Status Popover, 通知系统, Todo Dock, Followup Suggestions, Revert Dock, Question/Permission Dock, 外部应用打开, Theme Observer, Route Preload）

### P2（2-3 个月，新增 24 个）
1. Tool Intent 追踪字段
2. Diagnostic 注入机制
3. Legacy Compatibility Shim
4. Extension Dashboard
5. Hook Input Component
6. Deferred Persistence
7. Savings Journal
8. ScanRenderability
9. CompactMode 多策略
10. Session Fork 跨项目
11. Pluggable Remote Execution
12. Truncation Cleanup
13. Tool Description 结构化 Prompt
14. Command Arity Dictionary
15-24. Web UI P2（Debug Bar, Route Prefetch, Loading 进度条, Mock Data, Persist+LRU, i18n, Context Menu, HoverCard, Sticky Headers, Inline Editor, Terminal Panel）
