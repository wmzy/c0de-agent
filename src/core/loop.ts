import { chatStream as llmChatStream } from '../llm/provider.js'
import { resolveRoute } from '../llm/registry.js'
import { isLLMError } from '../llm/schema/errors.js'
import { detectProjectInfo } from '../project/detect.js'
import { entriesToChatMessages, getSessionContext } from '../session/context.js'
import { appendMessage, getMessages } from '../session/message.js'
import { appendLLMDetail, createSession } from '../session/session.js'
import { estimateTokens } from '../session/token.js'
import { generateId } from '../shared/index.js'
import type { AgentEvent, AgentState, LLMDetail } from '../shared/types/agent.js'
import type { ChatRequest, ChatTool, FinishReason, StreamChunk } from '../shared/types/llm.js'
import type { MessageContent, Session } from '../shared/types/message.js'
import type { SubAgentRequest, SubAgentResult, ToolResult } from '../shared/types/tool.js'
import { createAgent, runAgent } from './agent.js'
import { createSummarizer, runCompaction } from './compact.js'
import { calibrateEstimate, estimateBudget, shouldCompact } from './context.js'
import {
  DEFAULT_EDIT_MODE,
  getToolMetrics,
  inferToolMode,
  recordToolMetrics,
  selectBestMode,
} from './metrics.js'
import { buildSystemPrompt } from './prompt.js'
import { buildDynamicPrompt } from './prompt-registry.js'
import { drainSteering } from './steering.js'
import type { CollectedToolCall } from './tool-exec.js'
import { executeToolCalls } from './tool-exec.js'
import type { AgentDependencies } from './types.js'
import type { RepoBaseline } from './worktree.js'
import {
  applyPatchToParent,
  captureBaseline,
  captureDeltaPatch,
  createWorktree,
  removeWorktree,
} from './worktree.js'

type LoopDeps = AgentDependencies & {
  chatStream?: typeof llmChatStream
  /** 子 agent 运行时注入：yield 工具的结果收集器（透传到 ToolContext.collectYield）。 */
  readonly _subagentYieldCollector?: (data: unknown) => void
  /** 子 agent 运行时注入：事件回调，子 agent 的 subagent_start/end 事件推入此 sink，
   *  由父 agentLoop 缓冲后在工具执行后 yield 出去（spec §4.5 step 7）。 */
  readonly _subagentEventSink?: (event: AgentEvent) => void
  /** 当前递归深度（0=顶层主 agent）。用于 maxRecursion 控制（spec §4.5 step 4）。 */
  readonly _subagentDepth?: number
}

export type { LoopDeps }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForResume(state: AgentState): Promise<void> {
  while (true) {
    await sleep(100)
    if (state.status._tag !== 'paused') return
  }
}

/** 运行一个按类型派发的子 agent（spec: multi-agent-design §4.5）。
 *
 *  Host 端实现：查 agentRegistry 获取 AgentDefinition → 创建隔离子 session（agentType 记录）
 *  → 构建子 agent（专属 prompt + 受限工具集 + yield）→ 运行到 yield 或完成 → 返回结果。
 *  发射 subagent_start/subagent_end 事件供父 agent 转发（spec §4.5 step 7）。
 *  abort 链接父→子。maxRecursion 控制子 agent 能否再递归派生 task（spec §4.5 step 4）。
 *  def.isolated 时在 git worktree 中运行，结束后把 delta 自动 apply 回父仓库（spec §4.6）。
 *  request.background 时 fork 异步运行，立即返回 running（spec §4.7）。 */
export async function runSubAgent(
  deps: LoopDeps,
  parent: AgentState,
  request: SubAgentRequest,
): Promise<SubAgentResult> {
  // 1. 查 agent 类型
  if (!deps.agentRegistry) {
    return { _tag: 'error', error: 'task tool unavailable: no agent registry is wired' }
  }
  const def = deps.agentRegistry.get(request.agentType)
  if (!def) {
    return {
      _tag: 'error',
      error: `Unknown agent type: ${request.agentType} is not a valid agent type`,
    }
  }

  const title =
    request.description?.trim() ||
    `Sub-agent (${request.agentType}): ${request.prompt.slice(0, 60)}`
  const childId = generateId()
  const yielded: unknown[] = []

  // 发射 subagent_start 事件（spec §4.5 step 7）
  deps._subagentEventSink?.({
    _tag: 'subagent_start',
    childId,
    agentType: request.agentType,
    description: request.description ?? '',
    background: request.background ?? false,
  })

  // 2. 创建子 session（记录 agentType）
  let childSession: Session
  try {
    childSession = await createSession(
      deps.db,
      title,
      parent.session.projectId ?? undefined,
      request.agentType,
    )
  } catch (e) {
    return { _tag: 'error', error: e instanceof Error ? e.message : String(e) }
  }

  // 3. worktree 隔离（isolated agent）：失败回退共享 cwd
  let worktreePath: string | undefined
  let baseline: RepoBaseline | undefined
  if (def.isolated) {
    try {
      baseline = await captureBaseline(deps.cwd)
      worktreePath = await createWorktree(deps.cwd, `subagent-${childSession.id}`)
    } catch (e) {
      console.warn(
        `[subagent] worktree creation failed, falling back to shared cwd: ${e instanceof Error ? e.message : e}`,
      )
    }
  }
  const childCwd = worktreePath ?? deps.cwd

  // 实际运行子 agent 的内部函数（sync 与 background 共用）
  const runBody = async (): Promise<SubAgentResult> => {
    // 4. 构建子 agent 配置：工具集隔离 + 模型覆盖 + 递归限制 + yield
    const parentDepth = deps._subagentDepth ?? 0
    const childDepth = parentDepth + 1
    const declaredTools = def.tools ?? parent.config.tools
    const maxRec = def.maxRecursion ?? 0
    const baseTools =
      childDepth > maxRec ? declaredTools.filter((t) => t !== 'task') : declaredTools
    const childTools = Array.from(new Set([...baseTools, 'yield']))
    const childConfig = {
      ...parent.config,
      systemPrompt: def.systemPrompt,
      tools: childTools,
      ...(def.model ? { model: def.model } : {}),
      ...(request.model ? { model: request.model } : {}),
    }

    // 子 agent 的 deps：覆盖 cwd（worktree）+ 注入 yield 收集器 + 递归深度
    const childDeps: LoopDeps = {
      ...deps,
      cwd: childCwd,
      _subagentYieldCollector: (data: unknown) => {
        yielded.push(data)
      },
      _subagentDepth: childDepth,
    }

    const childState = await createAgent(childSession, childConfig, childDeps)

    // abort 链接：父 abort 则子 abort
    if (parent.abortController.signal.aborted) {
      childState.abortController.abort()
    } else {
      parent.abortController.signal.addEventListener(
        'abort',
        () => childState.abortController.abort(),
        { once: true },
      )
    }

    // 运行子 agent loop
    const childPrompt = request.context
      ? `CONTEXT\n${request.context}\n\nASSIGNMENT\n${request.prompt}`
      : request.prompt
    const text: string[] = []
    let errMsg: string | null = null
    try {
      for await (const ev of runAgent(
        childState,
        [{ _tag: 'text', text: childPrompt }],
        childDeps,
      )) {
        if (ev._tag === 'text_delta') {
          text.push(ev.text)
        } else if (ev._tag === 'error') {
          const e = ev.error
          errMsg = e._tag === 'unexpected' || e._tag === 'provider' ? e.message : e._tag
        }
      }
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e)
    }

    // 5. worktree 回传：仅成功时把 delta apply 回父仓库（spec §4.6）；无论成败都清理 worktree
    if (baseline && worktreePath) {
      if (errMsg === null) {
        try {
          const patch = await captureDeltaPatch(worktreePath, baseline)
          await applyPatchToParent(deps.cwd, patch, `agent(isolated): ${title}`)
        } catch (e) {
          console.warn(`[subagent] worktree apply failed: ${e instanceof Error ? e.message : e}`)
        }
      }
      removeWorktree(deps.cwd, worktreePath)
    }

    const success = errMsg === null

    // 发射 subagent_end 事件（spec §4.5 step 7）
    deps._subagentEventSink?.({
      _tag: 'subagent_end',
      childId,
      agentType: request.agentType,
      success,
      ...(success ? { output: text.join('') } : {}),
    })

    if (errMsg !== null) {
      return { _tag: 'error', error: errMsg, sessionId: childSession.id }
    }
    const data = yielded.length > 0 ? (yielded.length === 1 ? yielded[0] : yielded) : undefined
    return {
      _tag: 'success',
      output: text.join(''),
      sessionId: childSession.id,
      ...(data !== undefined ? { data } : {}),
    }
  }

  // 6. background 模式：fork 异步运行，立即返回 running；完成时向父 session 注入合成通知
  if (request.background) {
    const jobId = childSession.id
    void runBody()
      .then((result) => {
        const success = result._tag === 'success'
        const output = success ? result.output : (result as { error: string }).error
        const tag = success ? 'task_result' : 'task_error'
        const synthetic = `<task id="${childSession.id}" state="${success ? 'completed' : 'failed'}">\n<${tag}>\n${output}\n</${tag}>\n</task>`
        void appendMessage(deps.db, parent.session.id, {
          role: 'user',
          content: [{ _tag: 'text', text: synthetic }],
        }).catch(() => {})
      })
      .catch(() => {})
    return { _tag: 'running', jobId, sessionId: childSession.id }
  }

  return runBody()
}

function toolResultToContent(
  toolCallId: string,
  toolName: string,
  result: ToolResult,
): MessageContent[] {
  return [{ _tag: 'tool_result', id: toolCallId, tool: toolName, output: result }]
}

/** 入参是否为协议层/loop 标记的解析失败（携带 _parseError / _raw 容错标记）。
 * 这类入参是后端专用、只反馈给模型重试的，绝不能进入持久化消息或渲染层。 */
function isParseErrorInput(input: unknown): boolean {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false
  const obj = input as Record<string, unknown>
  return '_parseError' in obj || '_raw' in obj
}

export async function* agentLoop(state: AgentState, deps: LoopDeps): AsyncGenerator<AgentEvent> {
  const maxTurns = state.config.maxTurns ?? 50
  const streamFn = deps.chatStream ?? llmChatStream

  for (let turn = 0; turn < maxTurns; turn++) {
    if (state.abortController.signal.aborted) {
      yield { _tag: 'error', error: { _tag: 'aborted' } }
      return
    }

    // subagent 事件缓冲：runSubAgent 通过 sink 推入事件，executeToolCalls 后 yield 出去
    const subagentEvents: AgentEvent[] = []
    const eventSink = (ev: AgentEvent): void => {
      subagentEvents.push(ev)
    }
    if (state.status._tag === 'paused') {
      state.status = { _tag: 'running', turnCount: turn }
      yield { _tag: 'status_change', status: state.status }
      await waitForResume(state)
      if (state.status._tag !== 'running') return
    }
    state.status = { _tag: 'running', turnCount: turn }

    const steering = drainSteering(state)

    const { entries, snapshots } = await getSessionContext(deps.db, state.session.id)
    let chatMessages = entriesToChatMessages(entries, snapshots)

    for (const s of steering) {
      chatMessages.push({ role: 'system', content: s })
    }

    if (deps.hookRunner) {
      const hookResult = await deps.hookRunner.runHooks('message:before', {
        messages: chatMessages,
      })
      if (hookResult === false) {
        yield {
          _tag: 'error',
          error: { _tag: 'unexpected', message: 'Aborted by message:before hook' },
        }
        return
      }
      chatMessages = hookResult.messages
    }

    const promptCtx = {
      tools: state.tools,
      config: state.config,
      projectInfo: detectProjectInfo(deps.cwd),
      skills: [],
    }
    // spec §16.5：edit 工具模式偏好。仅当该轮启用 edit 且某模式历史成功率
    // 显著优于默认时，向 system prompt 追加偏好提示，引导模型选择高成功率模式。
    let modeHint = ''
    if (deps.config.toolMetrics.enabled) {
      const hasEdit = state.tools.some((t) => t.name === 'edit')
      if (hasEdit) {
        try {
          const ms = await getToolMetrics(deps.db, state.config.model, 'edit')
          const best = selectBestMode(ms, DEFAULT_EDIT_MODE, {
            threshold: deps.config.toolMetrics.threshold,
            minSamples: deps.config.toolMetrics.minSamples,
          })
          if (best !== DEFAULT_EDIT_MODE) {
            modeHint = `\n\n# Tool-mode preference\nFor the \`edit\` tool prefer the \`${best}\` mode (content-hash-anchored patch) — your historical success rate is highest with it for this model.`
          }
        } catch {
          // metrics 查询失败非致命，跳过偏好注入
        }
      }
    }
    const systemPrompt =
      (state.config.systemPrompt ??
        (deps.promptRegistry
          ? buildDynamicPrompt(deps.promptRegistry, promptCtx)
          : buildSystemPrompt(promptCtx))) + modeHint

    const tools: ChatTool[] = state.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))

    let request: ChatRequest = {
      model: state.config.model,
      messages: chatMessages,
      tools: tools.length > 0 ? tools : undefined,
      stream: true,
      system: systemPrompt,
      ...(state.config.maxTokens !== undefined ? { maxTokens: state.config.maxTokens } : {}),
      ...(state.config.temperature !== undefined ? { temperature: state.config.temperature } : {}),
    }

    if (deps.hookRunner) {
      const hookResult = await deps.hookRunner.runHooks('provider:before', { request })
      if (hookResult === false) {
        yield {
          _tag: 'error',
          error: { _tag: 'unexpected', message: 'Aborted by provider:before hook' },
        }
        return
      }
      request = hookResult.request
    }

    // 总是收集完整 chunk 序列：既供 hookRunner 触发 provider:after，
    // 也是 LLMDetail.responseChunks 的来源（用于调用详情展示）。
    const collectedChunks: StreamChunk[] = []
    const collectedText: string[] = []
    const collectedThinking: string[] = []
    const collectedToolCalls: Map<string, CollectedToolCall> = new Map()
    const toolCallArgs: Map<string, string> = new Map()
    let collectedUsage: { inputTokens: number; outputTokens: number; cacheRead?: number } | null =
      null
    let hadError = false
    // 非正常停止原因（length=被 max_tokens 截断, content_filter=被内容过滤）。
    // 若在无 tool_call 的完成分支里仍非 null，说明回答被截断/过滤而非正常说完。
    let truncated: FinishReason | null = null
    const requestStartTime = Date.now()
    let firstTokenTime: number | null = null

    try {
      for await (const chunk of streamFn(
        {
          registry: deps.llmRegistry,
          signal: state.abortController.signal,
        },
        request,
        { provider: state.config.provider, model: state.config.model },
      )) {
        if (firstTokenTime === null && chunk._tag !== 'done') {
          firstTokenTime = Date.now()
        }
        collectedChunks.push(chunk)
        if (state.abortController.signal.aborted) {
          yield { _tag: 'error', error: { _tag: 'aborted' } }
          return
        }

        switch (chunk._tag) {
          case 'text':
            collectedText.push(chunk.text)
            yield { _tag: 'text_delta', text: chunk.text }
            break
          case 'tool_call_start':
            // 仅登记，不立即发射 AgentEvent。此时入参尚未到达（流式 delta 累积中），
            // 过早发射空入参的 tool_call_start 会让前端渲染 "Glob · " 等半成品卡，
            // 且该 part 的入参之后也不会被纠正。tool_call_start 改在入参解析完成后、
            // 携带真实入参时统一发射（见本轮流结束后的处理）。
            collectedToolCalls.set(chunk.id, {
              id: chunk.id,
              tool: chunk.name,
              input: {},
            })
            toolCallArgs.set(chunk.id, '')
            break
          case 'tool_call_delta': {
            const existing = toolCallArgs.get(chunk.id) ?? ''
            toolCallArgs.set(chunk.id, existing + chunk.argumentsDelta)
            break
          }
          case 'tool_call_end': {
            const id = chunk.id
            const finalArgs = chunk.argumentsFinal ?? toolCallArgs.get(id) ?? '{}'
            let parsed: unknown = {}
            try {
              parsed = JSON.parse(finalArgs)
            } catch (e) {
              // 与协议层 finishAll 的容错标记保持一致：同时带 _parseError（可读）与 _raw。
              parsed = {
                _parseError: e instanceof Error ? e.message : String(e),
                _raw: finalArgs,
              }
            }
            const tc = collectedToolCalls.get(id)
            if (tc) tc.input = parsed
            break
          }
          case 'thinking':
            collectedThinking.push(chunk.text)
            yield { _tag: 'thinking', text: chunk.text }
            break
          case 'usage':
            collectedUsage = {
              inputTokens: chunk.inputTokens,
              outputTokens: chunk.outputTokens,
              cacheRead: chunk.cacheRead,
            }
            yield {
              _tag: 'usage',
              input: chunk.inputTokens,
              output: chunk.outputTokens,
              cacheRead: chunk.cacheRead,
            }
            break
          case 'done':
            if (chunk.finishReason === 'length' || chunk.finishReason === 'content-filter') {
              truncated = chunk.finishReason
            }
            break
          case 'error':
            yield {
              _tag: 'error',
              error: {
                _tag: 'provider',
                message: chunk.error.message,
                retryable: chunk.error.retryable ?? false,
              },
            }
            hadError = true
            break
        }
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : isLLMError(err)
            ? err.message
            : typeof err === 'object' && err !== null && 'message' in err
              ? String((err as { message: unknown }).message)
              : String(err)
      yield {
        _tag: 'error',
        error: {
          _tag: 'unexpected',
          message,
        },
      }
      state.status = {
        _tag: 'stopped',
        reason: 'error',
        error: {
          _tag: 'unexpected',
          message,
        },
      }
      return
    }

    if (deps.hookRunner) {
      await deps.hookRunner.fireHooks('provider:after', { request, chunks: collectedChunks })
    }

    // 记录本轮 LLM 调用详情，供前端调用详情面板展示。
    const totalLatency = Date.now() - requestStartTime
    // 解析模型能力：拿 contextWindow（供总结面板使用率）与单价（计算成本）。
    // resolveRoute 在 provider 未注册时抛 NoRoute；此处容错，失败则跳过补充字段。
    let contextWindow: number | undefined
    let computedCost = 0
    try {
      const { capabilities } = resolveRoute(
        deps.llmRegistry,
        state.config.provider,
        state.config.model,
      )
      contextWindow = capabilities.contextWindow
      const inputTokens = collectedUsage?.inputTokens ?? 0
      const outputTokens = collectedUsage?.outputTokens ?? 0
      computedCost =
        (inputTokens / 1000) * capabilities.costPer1kInput +
        (outputTokens / 1000) * capabilities.costPer1kOutput
    } catch {
      // provider 未注册或模型未知：保留 contextWindow=undefined、cost=0
    }
    const detail: LLMDetail = {
      id: generateId(),
      timestamp: requestStartTime,
      model: state.config.model,
      provider: state.config.provider,
      role: { _tag: 'default' },
      systemPrompt,
      messages: chatMessages,
      tools,
      responseChunks: collectedChunks,
      thinking: collectedThinking.length > 0 ? collectedThinking.join('') : undefined,
      usage: {
        input: collectedUsage?.inputTokens ?? 0,
        output: collectedUsage?.outputTokens ?? 0,
        cacheRead: collectedUsage?.cacheRead,
      },
      latency: {
        firstToken: firstTokenTime ? firstTokenTime - requestStartTime : totalLatency,
        total: totalLatency,
      },
      cost: computedCost,
      contextWindow,
    }
    state.llmDetails.push(detail)
    // 持久化到 sessions.metadata.llmDetails，供会话结束后仍可查看调用详情。
    await appendLLMDetail(deps.db, state.session.id, detail)
    // 通知前端调用详情已更新，使其刷新调用详情面板（避免需手动刷新页面）。
    yield { _tag: 'llm_detail' }

    if (hadError) {
      state.status = { _tag: 'stopped', reason: 'error' }
      return
    }

    // 过滤掉无效 tool call（id 或工具名为空）。部分输出不规范的 provider
    // 会把单个 tool call 的 arguments 流式片段拆成多个独立 delta，每片
    // id/name 为空——这些碎片无法执行，且其空 id 在下一轮发回 provider 时
    // 触发 "invalid tool_call_id"。这里在持久化/执行前将其丢弃。
    const validToolCalls = Array.from(collectedToolCalls.values()).filter(
      (c) => c.id.length > 0 && c.tool.length > 0,
    )

    // 区分入参解析成功 / 失败的调用。解析失败（模型输出不完整 JSON，常见于流被截断）
    // 的调用对系统完全透明：不执行、不持久化、不发前端事件（见下方工具执行块说明），
    // 仅保留解析成功的调用供执行与持久化，避免 _raw/_parseError 容错标记泄漏。
    const validCalls: CollectedToolCall[] = validToolCalls.filter(
      (tc) => !isParseErrorInput(tc.input),
    )

    const assistantContent: MessageContent[] = []
    if (collectedText.length > 0) {
      assistantContent.push({ _tag: 'text', text: collectedText.join('') })
    }
    // 仅持久化解析成功的调用（携带真实入参）。解析失败的入参是容错标记，不能落库。
    for (const tc of validCalls) {
      assistantContent.push({
        _tag: 'tool_call',
        id: tc.id,
        tool: tc.tool,
        input: tc.input,
      })
    }
    if (assistantContent.length > 0) {
      const savedMsg = await appendMessage(deps.db, state.session.id, {
        role: 'assistant',
        content: assistantContent,
      })
      if (deps.hookRunner) {
        await deps.hookRunner.fireHooks('message:after', { message: savedMsg })
      }
    }

    // 工具调用卡只在入参解析完成后、携带真实入参时才向前端发射 tool_call_start。
    // 这样前端拿到的第一帧就是可渲染的完整入参，不再出现空 pattern 半成品卡。
    // 解析失败的调用不发射 start，其 tool_call_end 在前端无匹配 part 会被忽略，
    // 因此解析失败在 UI 中不可见（模型会立即重试），错误仅反馈给模型并落库。
    for (const tc of validCalls) {
      yield { _tag: 'tool_call_start', id: tc.id, tool: tc.tool, input: tc.input }
    }

    // 仅执行解析成功的工具调用。解析失败的调用（isParseErrorInput 为真）对系统完全透明：
    // 不执行、不持久化 tool result、不发 tool_call_start/end。其入参是 _parseError/_raw
    // 容错标记，既不能执行也不能落库；若持久化为 orphan tool 消息（无对应 assistant
    // tool_call），context.ts 的 sanitizeToolPairs 会在重建上下文时将其丢弃——即模型
    // 永远收不到这个"错误反馈"，徒增一次注定被忽略的 DB 写。故让 parse-error 对模型
    // 不可见：模型下轮基于已持久化的 assistant 文本/有效 tool_call 重新生成，通常能
    // 修正一次性的流截断错误。
    if (validCalls.length > 0) {
      const toolExecStart = Date.now()
      const results = await executeToolCalls(
        deps.toolRegistry,
        deps.permission,
        {
          cwd: deps.cwd,
          session: { id: state.session.id, cwd: deps.cwd },
          abort: state.abortController.signal,
          ...(deps.urlRegistry ? { urlRegistry: deps.urlRegistry } : {}),
          ...(deps.debugSpawn ? { debugSpawn: deps.debugSpawn } : {}),
          runSubAgent: (req) => runSubAgent({ ...deps, _subagentEventSink: eventSink }, state, req),
          ...(deps._subagentYieldCollector ? { collectYield: deps._subagentYieldCollector } : {}),
        },
        validCalls,
        deps.hookRunner,
      )
      const toolLatency = Date.now() - toolExecStart
      const metricsEnabled = deps.config.toolMetrics.enabled
      for (const { id, result } of results) {
        yield { _tag: 'tool_call_end', id, result }
        const tc = validCalls.find((c) => c.id === id)
        if (tc) {
          await appendMessage(deps.db, state.session.id, {
            role: 'tool',
            content: toolResultToContent(id, tc.tool, result),
          })
          // spec §16.5：记录工具执行结果供后续模式评估。
          // fire-and-forget：记录失败绝不阻塞 agent 主流程。
          if (metricsEnabled) {
            const mode = inferToolMode(tc.tool, tc.input)
            const success = result._tag === 'success' || result._tag === 'truncated'
            void recordToolMetrics(
              deps.db,
              state.config.model,
              tc.tool,
              mode,
              success,
              toolLatency,
            ).catch(() => {})
          }
        }
      }
    }

    // yield 在本轮工具执行中收集的 subagent 事件（subagent_start/end）
    for (const ev of subagentEvents) {
      yield ev
    }

    if (validToolCalls.length === 0) {
      // finish_reason=length/content_filter 表示响应被截断或被内容过滤，而非正常说完。
      // 若当作 completed，被截断的半截回答会静默成功（用户看到“中断但无报错”）。
      if (truncated !== null) {
        const message =
          truncated === 'length'
            ? 'Response truncated: the model hit max_tokens before finishing (finish_reason=length)'
            : 'Response filtered by content policy (finish_reason=content_filter)'
        yield { _tag: 'error', error: { _tag: 'unexpected', message } }
        state.status = { _tag: 'stopped', reason: 'error', error: { _tag: 'unexpected', message } }
        return
      }
      state.status = { _tag: 'stopped', reason: 'completed' }
      yield { _tag: 'done' }
      return
    }

    const latestMessages = await getMessages(deps.db, state.session.id)
    // 校准估算系数：本轮真实 input token（system prompt + 工具描述 + 消息序列全口径）
    // 反算 estimateTokens 的系统性系数，反哺 used/fitToBudget 的裁剪与压缩判断。
    if (collectedUsage && collectedUsage.inputTokens > 0) {
      const estimatedRequest =
        estimateTokens(systemPrompt) +
        tools.reduce((sum, t) => sum + estimateTokens(JSON.stringify(t)), 0) +
        estimateTokens(JSON.stringify(chatMessages))
      state.calibrationFactor = calibrateEstimate(
        state.calibrationFactor,
        estimatedRequest,
        collectedUsage.inputTokens,
      )
    }
    state.tokenBudget.used = estimateBudget(latestMessages, state.calibrationFactor)
    state.messages = latestMessages

    if (shouldCompact(latestMessages, state.tokenBudget, deps.config.compaction)) {
      const summarizer = state.compactionModel
        ? createSummarizer(
            deps.llmRegistry,
            state.compactionModel.provider,
            state.compactionModel.model,
            { signal: state.abortController.signal },
          )
        : createSummarizer(deps.llmRegistry, state.config.provider, state.config.model, {
            signal: state.abortController.signal,
          })
      try {
        await runCompaction(deps.db, state.session.id, summarizer, {
          keepRecent: deps.config.compaction.keepRecentTokens,
        })
        state.tokenBudget.used = estimateBudget(
          await getMessages(deps.db, state.session.id),
          state.calibrationFactor,
        )
      } catch {
        // Compaction failure is non-fatal
      }
    }
  }

  yield {
    _tag: 'error',
    error: { _tag: 'max_turns', maxTurns },
  }
  state.status = {
    _tag: 'stopped',
    reason: 'error',
    error: { _tag: 'max_turns', maxTurns },
  }
}
