# Agent Loop 详细设计

> 基于 pi、oh-my-pi、opencode、oh-my-openagent 的实现分析。

## 1. 参考项目分析

### 1.1 Pi（agent/agent-loop.ts）

**核心循环**：
- Event-stream 驱动的编排：LLM 调用 → 工具执行 → 继续循环
- 支持顺序和并行工具执行
- Steering 消息队列：运行中注入系统消息
- Follow-up 消息：工具结果自动追加

**生命周期事件**：
```
agent_start → turn_start → message_start → message_update → message_end
→ tool_execution_start → tool_execution_update → tool_execution_end
→ turn_end → agent_end
```

**AgentHarness**（36KB）：
- 完整 agent 生命周期管理
- 类型化的 Skill/PromptTemplate/Tool 泛型
- Hook 点：before_agent_start、context、tool_call、tool_result、before_provider_request/payload、after_provider_response、session 事件
- Pending session writes 管理
- Compaction 集成
- Stream options 和 turn state 管理

**暂停/中止**：
- AbortController 传递到工具执行
- Steering 消息通过队列注入
- Follow-up 消息支持自动续接

### 1.2 OpenCode（session/session.ts）

**Session 管理**：
- 扁平 session 表（SQLite）
- 消息通过 sessionId 关联
- 重试机制（retry.ts，7KB）
- 回退机制（revert.ts，5.8KB）

**Agent 循环**：
- 消息发送 → LLM 响应 → 工具执行 → 结果追加 → 继续
- 支持中断和恢复
- Run state 管理（running/paused/stopped）

### 1.3 Oh-My-OpenAgent（agents/sisyphus）

**Sisyphus 主 agent**（25.8KB）：
- 动态 prompt 构建（根据可用 agent/skills 动态组装）
- 多模型支持（Gemini、GPT-5、Claude 等各有专用 prompt）
- 工具选择策略
- 反模式检测和硬性阻断

**Agent 模式**：
- `primary`：主 agent
- `subagent`：子 agent
- `all`：两者皆可

### 1.4 Oh-My-Pi（AgentSession）

**四运行模式**：
- Interactive TUI
- Print（一次性输出）
- RPC（NDJSON stdin/stdout）
- ACP（Agent Client Protocol）

**Session 状态机**：
```
idle → running → paused → running（恢复）
                → idle（中止/完成）
```

---

## 2. c0de-agent Agent Loop 设计

### 2.1 状态机

```
┌──────┐ start ┌─────────┐
│ idle │──────→│ running │←──┐
└──────┘       └────┬────┘   │
                    │        │ resume
              pause │        │
                    ↓        │
               ┌─────────┐──┘
               │ paused  │
               └────┬────┘
                    │ abort
                    ↓
               ┌─────────┐
               │ stopped │
               └─────────┘
```

### 2.2 核心类型

```typescript
type AgentStatus =
  | { _tag: 'idle' }
  | { _tag: 'running'; currentTool?: string; turnCount: number }
  | { _tag: 'paused'; pauseReason: string; pendingToolCall?: PendingToolCall }
  | { _tag: 'stopped'; reason: 'completed' | 'aborted' | 'error'; error?: AgentError }

type AgentState = {
  id: string
  session: Session
  messages: Message[]
  tools: ToolDef[]
  config: AgentConfig
  status: AgentStatus
  abortController: AbortController
  steeringQueue: string[]
  llmDetails: LLMDetail[]
  tokenBudget: TokenBudget
}

type AgentEvent =
  | { _tag: 'status_change'; status: AgentStatus }
  | { _tag: 'text_delta'; text: string }
  | { _tag: 'tool_call_start'; id: string; tool: string; input: unknown }
  | { _tag: 'tool_call_progress'; id: string; progress: string }
  | { _tag: 'tool_call_end'; id: string; result: ToolResult }
  | { _tag: 'thinking'; text: string }
  | { _tag: 'usage'; input: number; output: number; cacheRead?: number }
  | { _tag: 'permission_required'; toolCallId: string; tool: string; input: unknown }
  | { _tag: 'error'; error: AgentError }
  | { _tag: 'done' }
```

### 2.3 核心函数

```typescript
// 创建 agent
export function createAgent(config: AgentConfig): AgentState

// 运行 agent（AsyncGenerator 驱动）
export function runAgent(state: AgentState, message: Message): AsyncGenerator<AgentEvent>

// 暂停 agent
export function pauseAgent(state: AgentState): void

// 恢复 agent
export function resumeAgent(state: AgentState): void

// 中止 agent
export function abortAgent(state: AgentState): void

// 注入 steering 消息
export function injectSteering(state: AgentState, message: string): void

// 获取状态
export function getAgentStatus(state: AgentState): AgentStatus
```

### 2.4 Agent Loop 实现

```typescript
async function* agentLoop(state: AgentState): AsyncGenerator<AgentEvent> {
  const maxTurns = state.config.maxTurns ?? 50

  for (let turn = 0; turn < maxTurns; turn++) {
    // 1. 检查暂停状态
    while (state.status._tag === 'paused') {
      await waitForResume(state)
    }
    if (state.status._tag === 'stopped') break

    // 2. 处理 steering 消息
    while (state.steeringQueue.length > 0) {
      const steering = state.steeringQueue.shift()!
      state.messages.push({ role: 'system', content: steering, _tag: 'steering' })
    }

    // 3. 构建 LLM 请求
    const request = buildChatRequest(state)

    // 4. 记录 LLM 调用详情
    const llmDetail = createLLMDetail(request)
    state.llmDetails.push(llmDetail)

    // 5. 调用 LLM（带 fallback）
    let hasToolCalls = false
    let currentToolCall: { id: string; name: string; args: string } | null = null

    try {
      for await (const chunk of chatStreamWithFallback(state.registry, request, state.fallbackChain)) {
        // 检查中止
        if (state.abortController.signal.aborted) {
          yield { _tag: 'error', error: { _tag: 'aborted' } }
          return
        }

        // 检查暂停
        if (state.status._tag === 'paused') {
          yield { _tag: 'status_change', status: state.status }
          break
        }

        switch (chunk._tag) {
          case 'text':
            yield { _tag: 'text_delta', text: chunk.text }
            break

          case 'tool_call_start':
            hasToolCalls = true
            currentToolCall = { id: chunk.id, name: chunk.name, args: '' }
            yield { _tag: 'tool_call_start', id: chunk.id, tool: chunk.name, input: {} }
            break

          case 'tool_call_delta':
            if (currentToolCall) currentToolCall.args += chunk.argumentsDelta
            break

          case 'tool_call_end':
            if (currentToolCall) {
              // 执行工具
              const input = JSON.parse(currentToolCall.args)
              yield { _tag: 'tool_call_start', id: currentToolCall.id, tool: currentToolCall.name, input }

              const result = await executeToolWithPermission(state, currentToolCall, input)

              if (result._tag === 'permission_required') {
                yield { _tag: 'permission_required', toolCallId: currentToolCall.id, tool: currentToolCall.name, input }
                // 等待用户确认
                const confirmed = await waitForConfirmation(state, currentToolCall.id)
                if (!confirmed) {
                  result = { _tag: 'error', error: 'Permission denied by user' }
                }
              }

              yield { _tag: 'tool_call_end', id: currentToolCall.id, result }

              // 追加工具结果到消息
              state.messages.push({
                role: 'assistant',
                content: '',
                toolCalls: [{ id: currentToolCall.id, name: currentToolCall.name, arguments: currentToolCall.args }]
              })
              state.messages.push({
                role: 'tool',
                toolCallId: currentToolCall.id,
                content: JSON.stringify(result)
              })

              currentToolCall = null
            }
            break

          case 'thinking':
            yield { _tag: 'thinking', text: chunk.text }
            break

          case 'usage':
            yield { _tag: 'usage', input: chunk.inputTokens, output: chunk.outputTokens, cacheRead: chunk.cacheRead }
            llmDetail.usage = chunk
            break

          case 'done':
            break

          case 'error':
            yield { _tag: 'error', error: chunk.error }
            return
        }
      }
    } catch (error) {
      yield { _tag: 'error', error: { _tag: 'unexpected', message: String(error) } }
      return
    }

    // 6. 如果没有工具调用，本轮结束
    if (!hasToolCalls) {
      yield { _tag: 'done' }
      return
    }

    // 7. 检查 compaction
    if (shouldCompact(state.messages, state.tokenBudget, state.compactionConfig)) {
      state.messages = await compactMessages(state.messages, state.compactionConfig)
      yield { _tag: 'status_change', status: { _tag: 'running', turnCount: turn + 1 } }
    }
  }

  // 超过最大轮次
  yield { _tag: 'error', error: { _tag: 'max_turns', maxTurns } }
}
```

### 2.5 工具执行与权限

```typescript
async function executeToolWithPermission(
  state: AgentState,
  toolCall: { id: string; name: string; args: string },
  input: unknown
): Promise<ToolResult> {
  const tool = getTool(state.registry, toolCall.name)
  if (!tool) return { _tag: 'error', error: `Tool not found: ${toolCall.name}` }

  // 权限检查
  if (tool.permission === 'deny') return { _tag: 'error', error: 'Tool disabled' }
  if (tool.permission === 'ask') return { _tag: 'permission_required', reason: `${toolCall.name} requires confirmation` }

  // 执行
  const ctx: ToolContext = {
    cwd: state.cwd,
    session: { id: state.session.id, cwd: state.cwd },
    abort: state.abortController.signal
  }

  return await tool.execute(input, ctx)
}
```

### 2.6 暂停/恢复实现

```typescript
function pauseAgent(state: AgentState): void {
  if (state.status._tag !== 'running') return
  state.status = { _tag: 'paused', pauseReason: 'User requested pause' }
}

function resumeAgent(state: AgentState): void {
  if (state.status._tag !== 'paused') return
  state.status = { _tag: 'running', turnCount: 0 }
}

async function waitForResume(state: AgentState): Promise<void> {
  return new Promise(resolve => {
    const check = setInterval(() => {
      if (state.status._tag !== 'paused') {
        clearInterval(check)
        resolve()
      }
    }, 100)
  })
}
```

### 2.7 Steering 消息

```typescript
function injectSteering(state: AgentState, message: string): void {
  state.steeringQueue.push(message)
}

// 在 agent loop 中，每次 LLM 调用前检查 steering 队列
// steering 消息作为 system role 插入消息流
// 不持久化到 session（只影响当前轮次）
```

### 2.8 边界情况

| 场景 | 处理方式 |
|------|----------|
| LLM 超时 | 重试 1 次，失败切 fallback provider |
| 工具执行超时 | kill 进程树，返回 timeout 错误 |
| 工具崩溃 | 捕获异常，返回 error 结果 |
| 用户中止 | AbortController 触发，工具收到 signal |
| 用户暂停 | 设置 paused 状态，工具执行完当前操作后暂停 |
| Context 超限 | 触发 compaction，压缩后继续 |
| 最大轮次 | 返回 max_turns 错误 |
| 空响应 | 检查是否有 tool_calls，无则结束 |
| 并行工具调用 | 按顺序执行（简化实现，后续支持并行） |
