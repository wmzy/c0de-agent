# Agent Loop 详细设计

> 基于 pi、oh-my-pi、opencode、oh-my-openagent 的实现分析。

## 1. 参考项目分析

### 1.1 Pi（agent/agent-loop.ts）

**核心循环**：Event-stream 驱动，支持顺序和并行工具执行，steering 消息队列，follow-up 消息。

**生命周期事件**：`agent_start → turn_start → message_start → message_update → message_end → tool_execution_start → tool_execution_update → tool_execution_end → turn_end → agent_end`

**AgentHarness**（36KB）：完整生命周期管理，typed hooks（before_agent_start、context、tool_call、tool_result、before/after_provider_request/response），compaction 集成。

### 1.2 OpenCode（session/session.ts）

扁平 session 表（SQLite），重试机制（retry.ts 7KB），回退机制（revert.ts 5.8KB），run state 管理。

### 1.3 Oh-My-OpenAgent（agents/sisyphus）

Sisyphus 主 agent（25.8KB）：动态 prompt 构建，多模型专用 prompt，工具选择策略，反模式检测。

### 1.4 Oh-My-Pi（AgentSession）

四运行模式：TUI / Print / RPC / ACP。暂停/恢复状态机。

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
  compactionModel?: { provider: string; model: string }  // 压缩用独立模型
}

type AgentEvent =
  | { _tag: 'status_change'; status: AgentStatus }
  | { _tag: 'text_delta'; text: string }
  | { _tag: 'tool_call_start'; id: string; tool: string; input: unknown }
  | { _tag: 'tool_call_progress'; id: string; progress: string }
  | { _tag: 'tool_call_end'; id: string; result: ToolResult }
  | { _tag: 'tool_calls_parallel'; calls: { id: string; tool: string; input: unknown }[] }
  | { _tag: 'thinking'; text: string }
  | { _tag: 'usage'; input: number; output: number; cacheRead?: number }
  | { _tag: 'permission_required'; toolCallId: string; tool: string; input: unknown }
  | { _tag: 'error'; error: AgentError }
  | { _tag: 'done' }
```

### 2.3 核心函数

```typescript
export function createAgent(config: AgentConfig): AgentState
export function runAgent(state: AgentState, message: Message): AsyncGenerator<AgentEvent>
export function pauseAgent(state: AgentState): void
export function resumeAgent(state: AgentState): void
export function abortAgent(state: AgentState): void
export function injectSteering(state: AgentState, message: string): void
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
    const llmDetail = createLLMDetail(request)
    state.llmDetails.push(llmDetail)

    // 4. 调用 LLM（带可配置重试 + fallback）
    let hasToolCalls = false
    const collectedToolCalls: Map<string, { id: string; name: string; args: string }> = new Map()

    try {
      const stream = chatStreamWithRetryAndFallback(
        state.registry, request, state.fallbackChain,
        state.config.llmRetryCount ?? 3,
        state.config.llmRetryDelay ?? 1000
      )

      for await (const chunk of stream) {
        if (state.abortController.signal.aborted) {
          yield { _tag: 'error', error: { _tag: 'aborted' } }
          return
        }

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
            collectedToolCalls.set(chunk.id, { id: chunk.id, name: chunk.name, args: '' })
            yield { _tag: 'tool_call_start', id: chunk.id, tool: chunk.name, input: {} }
            break

          case 'tool_call_delta': {
            const tc = collectedToolCalls.get(chunk.id)
            if (tc) tc.args += chunk.argumentsDelta
            break
          }

          case 'tool_call_end': {
            const tc = collectedToolCalls.get(chunk.id)
            if (tc) tc.args = chunk.argumentsFinal ?? tc.args
            break
          }

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

    // 5. 执行收集到的工具调用（支持并行）
    if (collectedToolCalls.size > 0) {
      const toolCalls = Array.from(collectedToolCalls.values())

      if (toolCalls.length === 1) {
        // 单个工具调用
        const tc = toolCalls[0]
        const input = JSON.parse(tc.args)
        const result = await executeToolWithPermission(state, tc, input)
        yield { _tag: 'tool_call_end', id: tc.id, result }
        appendToolMessages(state, tc, result)
      } else {
        // 多个并行工具调用
        yield { _tag: 'tool_calls_parallel', calls: toolCalls.map(tc => ({ id: tc.id, tool: tc.name, input: JSON.parse(tc.args) })) }
        const results = await executeParallelToolCalls(state, toolCalls)
        for (const { id, result } of results) {
          yield { _tag: 'tool_call_end', id, result }
          const tc = toolCalls.find(t => t.id === id)!
          appendToolMessages(state, tc, result)
        }
      }
    }

    // 6. 如果没有工具调用，本轮结束
    if (!hasToolCalls) {
      yield { _tag: 'done' }
      return
    }

    // 7. 检查 compaction（支持指定独立模型）
    if (await compactIfNeeded(state)) {
      yield { _tag: 'status_change', status: { _tag: 'running', turnCount: turn + 1 } }
    }
  }

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
  if (tool.permission === 'deny') return { _tag: 'error', error: 'Tool disabled' }
  if (tool.permission === 'ask') return { _tag: 'permission_required', reason: `${toolCall.name} requires confirmation` }

  const ctx: ToolContext = {
    cwd: state.cwd,
    session: { id: state.session.id, cwd: state.cwd },
    abort: state.abortController.signal
  }

  return await executeWithTimeoutWatch(tool, input, ctx, tool.timeout ?? 120_000)
}
```

### 2.6 超时观察（不杀死进程）

工具超时时不杀死进程，而是返回当前状态和最近日志给 LLM，由 LLM 决定是否继续等待：

```typescript
async function executeWithTimeoutWatch(
  tool: ToolDef,
  input: unknown,
  ctx: ToolContext,
  timeout: number
): Promise<ToolResult> {
  const execution = tool.execute(input, ctx)

  const timeoutPromise = new Promise<ToolResult>(resolve => {
    setTimeout(() => {
      resolve({
        _tag: 'success',
        output: `[TIMEOUT] Tool ${tool.name} has been running for ${timeout / 1000}s.\n` +
                `Current output:\n${getRecentOutput(tool)}\n\n` +
                `The tool is still running. You can:\n` +
                `1. Wait longer (the tool may complete soon)\n` +
                `2. Abort and try a different approach\n` +
                `3. Check if the command is correct`,
        metadata: { timedOut: true, elapsed: timeout, stillRunning: true }
      })
    }, timeout)
  })

  return await Promise.race([execution, timeoutPromise])
}
```

### 2.7 并行工具调用

多个工具调用使用 `Promise.allSettled` 并行执行（参考 pi/opencode，不做简化）：

```typescript
async function executeParallelToolCalls(
  state: AgentState,
  toolCalls: { id: string; name: string; args: string }[]
): Promise<{ id: string; result: ToolResult }[]> {
  // 检查写入冲突：操作同一文件的工具串行执行
  const { parallel, serial } = partitionByConflict(toolCalls)

  const results: { id: string; result: ToolResult }[] = []

  // 并行执行无冲突的工具
  if (parallel.length > 0) {
    const parallelResults = await Promise.allSettled(
      parallel.map(async tc => {
        const input = JSON.parse(tc.args)
        const result = await executeToolWithPermission(state, tc, input)
        return { id: tc.id, result }
      })
    )
    for (const r of parallelResults) {
      results.push(r.status === 'fulfilled' ? r.value : { id: 'unknown', result: { _tag: 'error', error: String(r.reason) } })
    }
  }

  // 串行执行有冲突的工具
  for (const tc of serial) {
    const input = JSON.parse(tc.args)
    const result = await executeToolWithPermission(state, tc, input)
    results.push({ id: tc.id, result })
  }

  return results
}

// 按文件路径检测写入冲突
function partitionByConflict(toolCalls: { id: string; name: string; args: string }[]) {
  const writeTools = new Set(['write', 'edit', 'bash'])
  const parallel: typeof toolCalls = []
  const serial: typeof toolCalls = []
  const writePaths = new Set<string>()

  for (const tc of toolCalls) {
    if (writeTools.has(tc.name)) {
      const input = JSON.parse(tc.args)
      const path = input.path ?? input.file
      if (path && writePaths.has(path)) {
        serial.push(tc)  // 冲突，串行
      } else {
        if (path) writePaths.add(path)
        parallel.push(tc)  // 无冲突，可并行
      }
    } else {
      parallel.push(tc)  // 只读工具，可并行
    }
  }

  return { parallel, serial }
}
```

### 2.7 Provider 错误分类

采用 opencode 的细粒度错误分类，支持非标准错误响应的模式匹配：

```typescript
// 错误分类（参考 opencode/schema/errors.ts）
type ProviderErrorReason =
  | { _tag: 'InvalidRequest'; message: string; classification?: 'context-overflow' }
  | { _tag: 'NoRoute'; message: string }
  | { _tag: 'Authentication'; message: string }
  | { _tag: 'RateLimit'; retryAfter?: number; message: string }
  | { _tag: 'QuotaExceeded'; message: string }
  | { _tag: 'ContentPolicy'; message: string }
  | { _tag: 'ProviderInternal'; status: number; message: string }
  | { _tag: 'Transport'; message: string }
  | { _tag: 'InvalidProviderOutput'; message: string }
  | { _tag: 'UnknownProvider'; message: string }

// Context overflow 检测（20+ 正则模式匹配各家 provider 的非标准错误）
const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /model_context_window_exceeded/i,
]

export function isContextOverflow(message: string): boolean {
  return CONTEXT_OVERFLOW_PATTERNS.some(p => p.test(message))
}

// 错误分类器（可扩展）
type ErrorClassifier = {
  classify(status: number, body: unknown, headers: Headers): ProviderErrorReason
}

// 每个 provider 注册自己的错误分类器
const classifiers: Map<string, ErrorClassifier> = new Map()

export function registerErrorClassifier(provider: string, classifier: ErrorClassifier): void
export function classifyError(provider: string, status: number, body: unknown, headers: Headers): ProviderErrorReason
```

### 2.8 重试策略

参考 opencode 的重试实现，支持 provider-specific 配置：

```typescript
// 重试配置（参考 opencode/session/retry.ts）
type RetryConfig = {
  maxRetries: number           // 最大重试次数（默认 3）
  initialDelay: number         // 初始延迟 ms（默认 2000）
  backoffFactor: number        // 退避因子（默认 2）
  maxDelay: number             // 最大延迟 ms（默认 30000）
  retryableErrors: string[]    // 可重试的错误类型
  retryableStatusCodes: number[]  // 可重试的 HTTP 状态码
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelay: 2000,
  backoffFactor: 2,
  maxDelay: 30_000,
  retryableErrors: ['RateLimit', 'ProviderInternal', 'Transport'],
  retryableStatusCodes: [429, 500, 502, 503, 504]
}

// 延迟计算（参考 opencode）
function calculateDelay(attempt: number, error?: ProviderErrorReason, config?: RetryConfig): number {
  const cfg = config ?? DEFAULT_RETRY_CONFIG

  // 如果有 retry-after header，使用它
  if (error?._tag === 'RateLimit' && error.retryAfter) {
    return Math.min(error.retryAfter * 1000, RETRY_MAX_DELAY)
  }

  // 指数退避
  return Math.min(
    cfg.initialDelay * Math.pow(cfg.backoffFactor, attempt - 1),
    cfg.maxDelay
  )
}

// 重试判断（参考 opencode 的 retryable 函数）
function isRetryable(error: ProviderErrorReason, config?: RetryConfig): boolean {
  const cfg = config ?? DEFAULT_RETRY_CONFIG
  return cfg.retryableErrors.includes(error._tag)
}

// 带重试的流式请求
async function* chatStreamWithRetry(
  registry: ProviderRegistry,
  request: ChatRequest,
  config?: RetryConfig
): AsyncGenerator<StreamChunk> {
  const cfg = config ?? DEFAULT_RETRY_CONFIG

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      yield* chatStream(registry, request)
      return
    } catch (error) {
      const classified = classifyErrorFromException(error)

      if (!isRetryable(classified, cfg) || attempt >= cfg.maxRetries) {
        throw error
      }

      const delay = calculateDelay(attempt, classified, cfg)
      await sleep(delay)
    }
  }
}

// 带 fallback 的重试
async function* chatStreamWithRetryAndFallback(
  registry: ProviderRegistry,
  request: ChatRequest,
  chain: FallbackChain,
  config?: RetryConfig
): AsyncGenerator<StreamChunk> {
  const providers = [chain.primary, ...chain.fallbacks]
  const errors: ProviderErrorReason[] = []

  for (const providerName of providers) {
    try {
      yield* chatStreamWithRetry(registry, { ...request, provider: providerName }, config)
      return
    } catch (error) {
      errors.push(classifyErrorFromException(error))
      // 继续尝试下一个 provider
    }
  }

  // 所有 provider 都失败
  yield { _tag: 'error', error: { _tag: 'all_providers_failed', errors } }
}
```

### 2.9 上下文压缩（支持独立模型）

```typescript
type CompactionConfig = {
  enabled: boolean
  threshold: number           // 触发阈值（token 使用率，如 0.8）
  provider?: string           // 压缩用 provider（默认用当前 provider）
  model?: string              // 压缩用模型（默认用 smol 角色模型）
  keepRecentTokens: number    // 保留最近消息的 token 数
  strategy: 'llm' | 'bitmap'  // 压缩策略
}

async function compactIfNeeded(state: AgentState): Promise<boolean> {
  if (!shouldCompact(state.messages, state.tokenBudget, state.compactionConfig)) {
    return false
  }

  // 使用指定模型进行压缩（默认用 smol 角色的便宜模型）
  const compactionModel = state.compactionModel ??
    resolveModel(state.registry, 'smol', state.roleRouting)

  const strategy = getCompactionStrategy(state.compactionConfig.strategy)
  const plan = strategy.prepareCompaction(state.messages, state.tokenBudget)
  const result = await strategy.compact(plan, compactionModel)

  const summaryEntry: SessionEntry = {
    _tag: 'compaction',
    id: generateId(),
    sessionId: state.session.id,
    summary: result.summary,
    originalEntryIds: result.originalEntryIds,
    tokenCount: result.tokenCount,
    timestamp: Date.now()
  }

  state.messages = [summaryEntry, ...plan.keepEntries]
  return true
}
```

### 2.10 暂停/恢复实现

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

### 2.11 Steering 消息

```typescript
function injectSteering(state: AgentState, message: string): void {
  state.steeringQueue.push(message)
}

// 在 agent loop 中，每次 LLM 调用前检查 steering 队列
// steering 消息作为 system role 插入消息流
// 不持久化到 session（只影响当前轮次）
```

### 2.12 边界情况

| 场景 | 处理方式 |
|------|----------|
| LLM 超时 | 可配置重试策略（次数/退避/可重试错误类型），指数退避，retry-after header 支持，全部失败切 fallback provider |
| LLM context overflow | 20+ 正则模式匹配各家 provider 的非标准错误，自动触发 compaction 后重试 |
| LLM 认证/配额错误 | 不重试，立即切 fallback provider |
| 工具执行超时 | **不杀死进程**，返回当前状态和最近日志给 LLM，由 LLM 决定是否继续等待 |
| 工具崩溃 | 捕获异常，返回 error 结果 |
| 用户中止 | AbortController 触发，工具收到 signal |
| 用户暂停 | 设置 paused 状态，工具执行完当前操作后暂停 |
| Context 超限 | 触发 compaction（可用独立便宜模型压缩），压缩后继续 |
| 最大轮次 | 返回 max_turns 错误 |
| 空响应 | 检查是否有 tool_calls，无则结束 |
| 并行工具调用 | `Promise.allSettled` 并行执行，写入冲突的工具串行执行 |
