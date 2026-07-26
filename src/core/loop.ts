import { createKanbanStore } from '../kanban/index.js'
import { chatStream as llmChatStream } from '../llm/provider.js'
import { isContextOverflowFailure } from '../llm/provider-error.js'
import { resolveRoute } from '../llm/registry.js'
import { isLLMError } from '../llm/schema/errors.js'
import { detectProjectInfo } from '../project/detect.js'
import { entriesToChatMessages, getSessionContext } from '../session/context.js'
import { appendMessage, getMessages } from '../session/message.js'
import { createSession, saveLLMSegments, segmentFingerprint } from '../session/session.js'
import { estimateTokens } from '../session/token.js'
import { generateId } from '../shared/index.js'
import type {
  AgentEvent,
  AgentState,
  LLMCall,
  LLMSegment,
  SegmentTrigger,
} from '../shared/types/agent.js'
import type { ChatRequest, ChatTool, FinishReason, StreamChunk } from '../shared/types/llm.js'
import type { Message, MessageContent, Session } from '../shared/types/message.js'
import type { SubAgentRequest, SubAgentResult, ToolResult } from '../shared/types/tool.js'
import { formatSummary, type TodoPhase } from '../tools/builtin/todo.js'
import { createAgent, runAgent } from './agent.js'
import { createSummarizer, runCompaction } from './compact.js'
import { calibrateEstimate, createTokenBudget, estimateBudget, shouldCompact } from './context.js'
import {
  DEFAULT_EDIT_MODE,
  getToolMetrics,
  inferToolMode,
  recordToolMetrics,
  selectBestMode,
} from './metrics.js'
import {
  buildDynamicPrompt,
  createPromptRegistry,
  registerPromptSection,
} from './prompt-registry.js'
import { drainSteering, injectSteering } from './steering.js'
import { applyTodoTags } from './todo-tags.js'
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

/** provider 未声明 contextWindow 时回填的保守下限（避免估计过大不压缩、过小过度压缩）。 */
const FALLBACK_CONTEXT_WINDOW = 32_000

/** 每个 agent 已解析的有效 contextWindow 缓存（真实值或保守估计）。
 *  避免每轮重复解析/告警，并防止估计值随每轮 input token 抖动导致预算基准漂移。 */
const effectiveContextWindowCache = new WeakMap<AgentState, number>()

/**
 * 解析本轮有效 contextWindow，确保 shouldCompact 始终有合理基准：
 *  - provider 已声明（capabilities.contextWindow 为正数）→ 原样采用，不改变正常配置行为。
 *  - 缺失（provider 未注册 / 模型未知 / 未声明 contextWindow）→ 以本轮真实 input token
 *    为下限回填保守估计 max(inputTokens × 2, FALLBACK_CONTEXT_WINDOW)，并在首次回填时
 *    console.warn 告警（非致命——provider 未配置 contextWindow 不是致命错误）。
 *
 * 结果按 agent 缓存：首轮回填后后续轮次复用同一估计值，告警仅触发一次，
 * 使 contextWindow 缺失时不再静默退化压缩阈值。
 */
function resolveEffectiveContextWindow(
  state: AgentState,
  raw: number | undefined,
  inputTokens: number,
  provider: string,
  model: string,
): number {
  // provider 已声明有效 contextWindow → 直接采用并缓存
  if (typeof raw === 'number' && raw > 0) {
    effectiveContextWindowCache.set(state, raw)
    return raw
  }
  // 已缓存（首轮已回填的估计值）→ 复用，避免重复告警与基准抖动
  const cached = effectiveContextWindowCache.get(state)
  if (cached !== undefined) return cached
  // 缺失：以本轮真实 input token 作下限回填保守估计
  const estimated = Math.max(inputTokens * 2, FALLBACK_CONTEXT_WINDOW)
  console.warn(
    `[loop] provider "${provider}" / model "${model}" 未声明 contextWindow，` +
      `使用保守估算值 ${estimated}（基于本轮 input token）。压缩阈值可能不准——` +
      `建议在 provider 配置中声明 contextWindow。`,
  )
  effectiveContextWindowCache.set(state, estimated)
  return estimated
}

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
      // 子 agent 走整段 systemPrompt 替换，清除父的 role override 避免干扰
      agentRolePrompt: undefined,
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
        }).catch((e) => {
          // 通知消息持久化失败：任务已算完但父 session 收不到完成通知——记录避免静默丢失。
          console.warn(
            '[subagent] background 通知消息持久化失败:',
            e instanceof Error ? e.message : String(e),
          )
        })
      })
      .catch((e) => {
        // background 子 agent 执行或合成失败：父 session 永远收不到结果，记录避免静默丢失。
        console.warn(
          '[subagent] background 子 agent 执行失败:',
          e instanceof Error ? e.message : String(e),
        )
      })
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

/**
 * 执行会话压缩并刷新 token 预算。
 *
 * 自动压缩（agentLoop 阈值触发）与手动 /compact 共用此逻辑：复用
 * createSummarizer + runCompaction，压缩改写消息历史后标记下一段 trigger='compaction'。
 *
 * 成功时 yield 一条 text_delta 通知：手动 /compact 透传给用户；自动压缩由调用方
 * 静默消费。失败时抛错，由调用方决定是否记录（自动压缩非致命，仅 console.warn）。
 */
export async function* compactContext(
  state: AgentState,
  deps: LoopDeps,
): AsyncGenerator<AgentEvent> {
  // summarizer 优先用 compactionModel 覆盖，否则回退当前会话 provider/model。
  const cm = state.compactionModel
  const summarizer = createSummarizer(
    deps.llmRegistry,
    cm ? cm.provider : state.config.provider,
    cm ? cm.model : state.config.model,
    { signal: state.abortController.signal },
  )
  const result = await runCompaction(deps.db, state.session.id, summarizer, {
    keepRecentTokens: deps.config.compaction.keepRecentTokens,
  })
  // 压缩改写了消息历史 → 标记下一轮强制开新段（段边界）
  state.pendingSegmentTrigger = 'compaction'
  state.tokenBudget.used = estimateBudget(
    await getMessages(deps.db, state.session.id),
    state.calibrationFactor,
  )
  yield {
    _tag: 'text_delta',
    text: result.compacted
      ? `Context compacted: ${result.compactedCount} messages summarized.`
      : 'Nothing to compact yet.',
  }
  // 压缩成功后分发事件（spec: plugin-hooks `session:compact`）：
  //  - session:compact hook（broadcast，插件可订阅；before=压缩条数，after=保留条数）
  //  - compaction_done AgentEvent（前端/UI 可观测，携带 summary/archiveId）
  // 仅在实际发生压缩时触发（nothing_to_compact 无 before/after 语义）。
  if (result.compacted) {
    if (deps.hookRunner) {
      await deps.hookRunner.fireHooks('session:compact', {
        before: result.compactedCount,
        after: result.keptCount,
      })
    }
    yield {
      _tag: 'compaction_done',
      summary: result.summary,
      archiveId: result.archiveId,
      compactedCount: result.compactedCount,
      keptCount: result.keptCount,
    }
    // 压缩成功后初始化退化监测器：监测接下来 5 轮 assistant 回复，
    // 若连续产生空回复（无实质文本且无 tool_call）则发出警告（不中断循环）。
    state.postCompactionMonitor = { remaining: 5, noTextStreak: 0 }
  }
}

/**
 * 响应式溢出恢复（reactive overflow compaction）：context-overflow 时压缩
 * 历史并刷新内存消息，使下一轮重建出更小的上下文。仅在 assistant 尚未开始
 * 输出（无 text delta、无 tool_call）时由调用方判定后调用。
 *
 * 成功返回 true（已压缩、已重载 messages，调用方 `continue` 重试本轮）；
 * 压缩失败返回 false，由调用方回退到原始错误处理（透传 error 并停止）。
 */
async function recoverFromOverflow(state: AgentState, deps: LoopDeps): Promise<boolean> {
  try {
    for await (const _ev of compactContext(state, deps)) {
      // 静默消费压缩通知（与自动压缩一致，不透传给用户）
    }
    state.messages = await getMessages(deps.db, state.session.id)
    return true
  } catch (e) {
    console.warn(
      '[overflow-recovery] compaction failed:',
      e instanceof Error ? e.message : String(e),
    )
    return false
  }
}

/** collectStreamChunks 的收集结果：单轮 LLM 流的全部产出与状态标记。 */
type StreamCollectResult = {
  /** 完整 chunk 序列（供 provider:after hook 与 LLMDetail.responseChunks） */
  chunks: StreamChunk[]
  /** 文本片段累积 */
  text: string[]
  /** thinking 片段累积 */
  thinking: string[]
  /** 解析后的 tool call（含容错标记的入参） */
  toolCalls: Map<string, CollectedToolCall>
  /** usage 统计（input/output/cacheRead） */
  usage: { inputTokens: number; outputTokens: number; cacheRead?: number } | null
  /** 非正常停止原因（length / content_filter），完成分支据此判断是否被截断 */
  truncated: FinishReason | null
  /** 流中出现过 error chunk */
  hadError: boolean
  /** 首个非 done chunk 到达时间（latency.firstToken 用） */
  firstTokenTime: number | null
  /** 更新后的溢出恢复标记：true 表示本轮已尝试过一次恢复（防无限循环） */
  overflowCompacted: boolean
  /** 溢出恢复成功 → 调用方需 `continue turnLoop` 重试本轮 */
  overflowRecovered: boolean
  /** 致命错误（abort / provider 抛错）→ 调用方应直接 return 终止 loop */
  fatalError: boolean
}

/** 解析 tool_call_end 的入参：JSON.parse + 容错标记。
 *  解析成功返回原值；失败返回 { _parseError, _raw } 容错标记（与协议层 finishAll 一致），
 *  供 isParseErrorInput 识别——这类入参只反馈给模型重试，绝不持久化或渲染。 */
function parseToolCallArgs(finalArgs: string): unknown {
  try {
    return JSON.parse(finalArgs)
  } catch (e) {
    return {
      _parseError: e instanceof Error ? e.message : String(e),
      _raw: finalArgs,
    }
  }
}

/** 流式收集 LLM 输出：遍历 streamFn 的 chunk，分类收集 text/thinking/tool_call/usage/done，
 *  实时透传 text_delta/thinking/usage/error 给 agentLoop 的消费者（通过 yield）。
 *
 *  内部处理响应式溢出恢复：context-overflow 且尚未开始输出（无 text、无 tool_call）
 *  时压缩历史，成功则置 overflowRecovered=true 由调用方 `continue turnLoop` 重试本轮。
 *  致命错误（abort / provider 抛错）置 fatalError=true 由调用方终止 loop。
 *
 *  注意：tool_call_start 仅登记、不发射 AgentEvent——入参尚未到达，过早发射空入参
 *  会让前端渲染半成品卡。tool_call_start 由 persistAssistantAndTools 在入参解析完成后统一发射。 */
async function* collectStreamChunks(
  state: AgentState,
  deps: LoopDeps,
  streamFn: typeof llmChatStream,
  request: ChatRequest,
  overflowCompacted: boolean,
): AsyncGenerator<AgentEvent, StreamCollectResult> {
  const chunks: StreamChunk[] = []
  const text: string[] = []
  const thinking: string[] = []
  const toolCalls: Map<string, CollectedToolCall> = new Map()
  const toolCallArgs: Map<string, string> = new Map()
  let usage: StreamCollectResult['usage'] = null
  let hadError = false
  // 非正常停止原因（length=被 max_tokens 截断, content_filter=被内容过滤）。
  // 若在无 tool_call 的完成分支里仍非 null，说明回答被截断/过滤而非正常说完。
  let truncated: FinishReason | null = null
  let firstTokenTime: number | null = null
  let recovered = overflowCompacted

  const finish = (over: Partial<StreamCollectResult>): StreamCollectResult => ({
    chunks,
    text,
    thinking,
    toolCalls,
    usage,
    truncated,
    hadError,
    firstTokenTime,
    overflowCompacted: recovered,
    overflowRecovered: false,
    fatalError: false,
    ...over,
  })

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
      chunks.push(chunk)
      if (state.abortController.signal.aborted) {
        yield { _tag: 'error', error: { _tag: 'aborted' } }
        return finish({ fatalError: true })
      }

      switch (chunk._tag) {
        case 'text':
          text.push(chunk.text)
          yield { _tag: 'text_delta', text: chunk.text }
          break
        case 'tool_call_start':
          // 仅登记，不立即发射 AgentEvent。此时入参尚未到达（流式 delta 累积中），
          // 过早发射空入参的 tool_call_start 会让前端渲染 "Glob · " 等半成品卡，
          // 且该 part 的入参之后也不会被纠正。tool_call_start 改在入参解析完成后、
          // 携带真实入参时统一发射（见 persistAssistantAndTools）。
          toolCalls.set(chunk.id, {
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
          const finalArgs = chunk.argumentsFinal ?? toolCallArgs.get(chunk.id) ?? '{}'
          const tc = toolCalls.get(chunk.id)
          if (tc) tc.input = parseToolCallArgs(finalArgs)
          break
        }
        case 'thinking':
          thinking.push(chunk.text)
          yield { _tag: 'thinking', text: chunk.text }
          break
        case 'usage':
          usage = {
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
        case 'error': {
          // 响应式溢出恢复：仅当尚未开始输出且未重试过时，压缩历史并重试本轮
          const isOverflow = chunk.error.classification === 'context-overflow'
          if (isOverflow && !recovered && text.length === 0 && toolCalls.size === 0) {
            recovered = true
            if (await recoverFromOverflow(state, deps)) {
              return finish({ overflowRecovered: true })
            }
          }
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
    }
  } catch (err) {
    // 响应式溢出恢复：provider 抛出的 context-overflow 是生产环境的实际路径
    // （httpPost 在非 2xx 时抛出已分类的 LLMError），与上方 error chunk 分支同理。
    if (isContextOverflowFailure(err) && !recovered && text.length === 0 && toolCalls.size === 0) {
      recovered = true
      if (await recoverFromOverflow(state, deps)) {
        return finish({ overflowRecovered: true })
      }
    }
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
    return finish({ fatalError: true })
  }
  return finish({})
}

/** 段管理：判断段边界（pending trigger / model / systemPrompt / tools 变化），
 *  构造本轮 LLMCall 并 push 到当前段，持久化 segments。直接修改 state.segments（引用语义）。
 *  trigger 判定用于新段元数据；needSegment 决定是否真正开新段（否则复用 activeSeg）。 */
async function manageSegment(
  state: AgentState,
  deps: LoopDeps,
  systemPrompt: string,
  tools: ChatTool[],
  requestStartTime: number,
  totalLatency: number,
  collectedUsage: StreamCollectResult['usage'],
  collectedText: string[],
  collectedThinking: string[],
  truncated: FinishReason | null,
  firstTokenTime: number | null,
  contextWindow: number | undefined,
  computedCost: number,
): Promise<void> {
  // —— 段管理：判断是否开新段 ——
  const fp = segmentFingerprint(systemPrompt, tools)
  const activeSeg = state.segments[state.segments.length - 1]
  const pendingTrigger = state.pendingSegmentTrigger
  let trigger: SegmentTrigger
  if (pendingTrigger) {
    trigger = pendingTrigger
    state.pendingSegmentTrigger = undefined
  } else if (!activeSeg) {
    trigger = 'initial'
  } else if (activeSeg.model !== state.config.model) {
    trigger = 'model_change'
  } else if (activeSeg.fingerprint !== fp) {
    trigger = activeSeg.systemPrompt !== systemPrompt ? 'system_prompt_change' : 'tools_change'
  } else {
    trigger = 'user_confirmed' // 占位，实际不会开段
  }
  const needSegment =
    !!pendingTrigger ||
    !activeSeg ||
    activeSeg.model !== state.config.model ||
    activeSeg.fingerprint !== fp
  let currentSeg: LLMSegment
  if (!needSegment && activeSeg) {
    currentSeg = activeSeg
  } else {
    currentSeg = {
      id: generateId(),
      fingerprint: fp,
      provider: state.config.provider,
      model: state.config.model,
      systemPrompt,
      tools,
      startedAt: requestStartTime,
      trigger,
      agentName: state.config.agentName,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      calls: [],
    }
    state.segments.push(currentSeg)
  }

  // —— 段内轻量 call ——
  const call: LLMCall = {
    id: generateId(),
    timestamp: requestStartTime,
    usage: {
      input: collectedUsage?.inputTokens ?? 0,
      output: collectedUsage?.outputTokens ?? 0,
      ...(collectedUsage?.cacheRead !== undefined ? { cacheRead: collectedUsage.cacheRead } : {}),
    },
    latency: {
      firstToken: firstTokenTime ? firstTokenTime - requestStartTime : totalLatency,
      total: totalLatency,
    },
    cost: computedCost,
    ...(collectedThinking.length > 0 ? { thinking: collectedThinking.join('') } : {}),
    responseText: collectedText.join(''),
    ...(truncated ? { finishReason: truncated } : {}),
  }
  currentSeg.calls.push(call)

  await saveLLMSegments(deps.db, state.session.id, state.segments)
}

/** 持久化 assistant 消息 + 执行工具调用 + 持久化 tool result + 记录 metrics，
 *  并透传 tool_call_start/tool_call_end/subagent 事件。
 *
 *  - 仅持久化/执行解析成功的调用（isParseErrorInput 过滤容错标记，避免 _raw/_parseError 落库）。
 *  - tool_call_start 仅在入参解析完成后、携带真实入参时发射（前端拿到的第一帧即完整入参）。
 *  - subagent 事件缓冲（runSubAgent → eventSink）在工具执行后 yield 出去（spec §4.5 step 7）。
 *  - metrics 记录为 fire-and-forget，失败绝不阻塞 agent 主流程。 */
async function* persistAssistantAndTools(
  state: AgentState,
  deps: LoopDeps,
  collectedText: string[],
  validCalls: CollectedToolCall[],
): AsyncGenerator<AgentEvent> {
  // subagent 事件缓冲：runSubAgent 通过 sink 推入事件，executeToolCalls 后 yield 出去
  const subagentEvents: AgentEvent[] = []
  const eventSink = (ev: AgentEvent): void => {
    subagentEvents.push(ev)
  }

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
        // todo 工具状态通过 dependency-reversal hook 注入：get/set 直接读写
        // state.todoPhases（in-memory），tool result 的 metadata.phases 充当
        // 持久化层——createAgent 时从历史消息恢复。
        todoState: {
          get: () => state.todoPhases,
          set: (phases) => {
            state.todoPhases = phases as typeof state.todoPhases
          },
        },
        // kanban 工具通过 dependency-reversal 注入：per-project 的 db-backed store。
        // 仅当 session 有 projectId 时启用（子 session 无 project 时不可用）。
        ...(state.session.projectId
          ? { kanbanStore: createKanbanStore(deps.db, state.session.projectId) }
          : {}),
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
}

/** Process <todo:*> tags embedded in assistant text.
 *  Parses tags, applies them to state.todoPhases via applyTodoTags,
 *  yields todo_update event on success, injects steering on error/view. */
async function* processTodoTags(state: AgentState, text: string): AsyncGenerator<AgentEvent> {
  if (text.length === 0) return
  const result = applyTodoTags(state.todoPhases as TodoPhase[], text)

  if (result.errors.length > 0) {
    // Inject error feedback into steering queue for next turn
    injectSteering(state, `<todo-tag-errors>\n${result.errors.join('\n')}\n</todo-tag-errors>`)
  }
  if (result.hasView) {
    // View request: inject current state (with seq) into steering
    const summary = formatSummary(result.phases, [], true)
    injectSteering(state, `<todo-state>\n${summary}\n</todo-state>`)
  }

  // Emit event + update state if anything happened
  const tagsFound = result.errors.length > 0 || result.hasView || result.phases !== state.todoPhases
  if (tagsFound) {
    state.todoPhases = result.phases
    yield { _tag: 'todo_update', phases: result.phases }
  }
}

/** 轮末压缩：turn-end 自动压缩（含死锁检测）+ mid-turn 压缩，复用 compactContext。
 *
 *  - turn-end：shouldCompact 触发时静默压缩；压缩后仍超阈值（典型成因 keepRecentTokens
 *    本身已超 historyBudget）则标记死锁暂停后续自动压缩，并发出非致命警告（不中断循环）。
 *    死锁在下一轮用户输入（agentLoop 重入）时重置。
 *  - mid-turn：midTurnEnabled 单独 opt-in（默认关闭）时按 enabled:true 阈值静默压缩，
 *    复用 shouldCompact 逻辑但不发 error/warning，压缩后刷新内存消息视图。
 *  两者都静默消费 compactContext 的 text_delta 通知（不透传给用户）。 */
async function* runCompactionIfNeeded(
  state: AgentState,
  deps: LoopDeps,
  latestMessages: Message[],
): AsyncGenerator<AgentEvent> {
  // 死锁时跳过自动压缩：上一轮压缩已证明无法释放足够空间，重试只会无限循环。
  if (
    !state.compactionDeadEnd &&
    shouldCompact(latestMessages, state.tokenBudget, deps.config.compaction)
  ) {
    // 自动压缩：复用 compactContext；失败非致命，仅记录警告不中断主循环。
    try {
      for await (const _ev of compactContext(state, deps)) {
        // 静默消费压缩通知事件，不透传给用户（保持自动压缩的原有静默语义）
      }
      // 进度保护：compactContext 已重算 state.tokenBudget.used。若压缩后仍超阈值
      // （典型成因：keepRecentTokens 本身已超 historyBudget），压缩无法再释放足够
      // 空间 → 标记死锁暂停后续自动压缩，并发出非致命警告（不中断循环）。
      // 死锁在下一轮用户输入（agentLoop 重入）时重置。
      const postMessages = await getMessages(deps.db, state.session.id)
      if (shouldCompact(postMessages, state.tokenBudget, deps.config.compaction)) {
        state.compactionDeadEnd = true
        yield {
          _tag: 'error',
          error: {
            _tag: 'unexpected',
            message:
              'Compaction freed too little context to make progress (keepRecentTokens may exceed the threshold). Auto-compaction paused until the next user message.',
          },
        }
      }
    } catch (e) {
      console.warn('[compaction] failed:', e instanceof Error ? e.message : String(e))
    }
  }

  // —— 中轮压缩（mid-run compaction）——
  // 单个 turn 内工具结果可能剧增 token（如长 bash 输出），在下一次 LLM 请求前
  // 按 midTurnEnabled 检查阈值并静默压缩。与上方 turn-end 自动压缩独立：
  // midTurnEnabled 是单独的 opt-in 闸门（默认关闭），以它为条件复用 shouldCompact
  // 的阈值逻辑（传入 enabled:true 使阈值判定不受 compaction.enabled 影响），
  // 便于在保留 turn-end 自动压缩行为的同时精确控制中轮压缩。
  // 此时 state.tokenBudget.used 已是最新值（上方已重算；若 turn-end 压缩已触发，
  // compactContext 内部也已重算），shouldCompact 只读取 budget，不依赖 messages。
  if (
    deps.config.compaction.midTurnEnabled === true &&
    !state.compactionDeadEnd &&
    shouldCompact(latestMessages, state.tokenBudget, {
      ...deps.config.compaction,
      enabled: true,
    })
  ) {
    // 中轮压缩静默执行：compactContext 内部已发 text_delta 通知，
    // 不再 yield error/warning（与 turn-end 自动压缩的进度保护语义不同）。
    try {
      for await (const _ev of compactContext(state, deps)) {
        // 静默消费压缩通知，不透传给用户
      }
      // 压缩改写了消息历史 → 刷新内存视图，供下一轮上下文重建使用
      state.messages = await getMessages(deps.db, state.session.id)
    } catch (e) {
      console.warn('[mid-turn-compaction] failed:', e instanceof Error ? e.message : String(e))
    }
  }
}

export async function* agentLoop(state: AgentState, deps: LoopDeps): AsyncGenerator<AgentEvent> {
  const maxTurns = state.config.maxTurns ?? 50
  const streamFn = deps.chatStream ?? llmChatStream
  // 响应式溢出恢复：context-overflow 时压缩后重试，最多 1 次（防无限循环）
  let overflowCompacted = false
  // 新一轮用户输入：重置压缩死锁标记（新消息改变上下文，压缩或许能再次生效）
  state.compactionDeadEnd = false

  for (let turn = 0; turn < maxTurns; turn++) {
    if (state.abortController.signal.aborted) {
      yield { _tag: 'error', error: { _tag: 'aborted' } }
      return
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

    // steering 消息必须插入到最后一条 user 消息之前（而非末尾 push），
    // 使 notice 在相关 user 消息的同一 turn 生效。
    // 参考 oh-my-pi magic-keyword fix：末尾 system 消息会被模型忽略。
    for (const s of steering) {
      let lastUserIdx = -1
      for (let i = chatMessages.length - 1; i >= 0; i--) {
        if (chatMessages[i]?.role === 'user') {
          lastUserIdx = i
          break
        }
      }
      if (lastUserIdx >= 0) {
        chatMessages.splice(lastUserIdx, 0, { role: 'system', content: s })
      } else {
        chatMessages.push({ role: 'system', content: s })
      }
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
    // primary agent 的 role prompt 覆盖 role section（保留工具/项目等动态段）。
    // 仅当未走 config.systemPrompt 整段替换时生效。
    const baseReg = deps.promptRegistry ?? createPromptRegistry()
    if (state.config.agentRolePrompt) {
      registerPromptSection(baseReg, {
        id: 'role',
        content: state.config.agentRolePrompt,
        priority: 0,
      })
    }
    const systemPrompt =
      (state.config.systemPrompt ?? buildDynamicPrompt(baseReg, promptCtx)) + modeHint

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

    const requestStartTime = Date.now()

    // —— 流式收集 LLM 输出（透传 text_delta/thinking/usage/error，内部处理溢出恢复）——
    const collected: StreamCollectResult = yield* collectStreamChunks(
      state,
      deps,
      streamFn,
      request,
      overflowCompacted,
    )
    overflowCompacted = collected.overflowCompacted
    // 溢出恢复成功 → 压缩历史后重试本轮（collectStreamChunks 已 reload messages）
    if (collected.overflowRecovered) continue
    // 致命错误（abort / provider 抛错）→ collectStreamChunks 已 yield error 并设状态，直接终止
    if (collected.fatalError) return

    if (deps.hookRunner) {
      await deps.hookRunner.fireHooks('provider:after', { request, chunks: collected.chunks })
    }

    const totalLatency = Date.now() - requestStartTime
    let contextWindow: number | undefined
    let computedCost = 0
    try {
      const { capabilities } = resolveRoute(
        deps.llmRegistry,
        state.config.provider,
        state.config.model,
      )
      contextWindow = capabilities.contextWindow
      const inputTokens = collected.usage?.inputTokens ?? 0
      const outputTokens = collected.usage?.outputTokens ?? 0
      computedCost =
        (inputTokens / 1000) * capabilities.costPer1kInput +
        (outputTokens / 1000) * capabilities.costPer1kOutput
    } catch {
      // provider 未注册或模型未知：保留 contextWindow=undefined、cost=0
    }

    // —— contextWindow 兜底 + token 预算同步 ——
    // provider 未声明 contextWindow 时回填保守估计（见 resolveEffectiveContextWindow），
    // 并把 token 预算同步到真实/估计 contextWindow（总数变化时重算，保留 used），
    // 使后续 shouldCompact 判断有合理基准，避免压缩阈值静默退化。
    const effectiveWindow = resolveEffectiveContextWindow(
      state,
      contextWindow,
      collected.usage?.inputTokens ?? 0,
      state.config.provider,
      state.config.model,
    )
    contextWindow = effectiveWindow
    if (state.tokenBudget.total !== effectiveWindow) {
      const used = state.tokenBudget.used
      state.tokenBudget = createTokenBudget(effectiveWindow)
      state.tokenBudget.used = used
    }

    // —— 段管理：判断段边界 + 构造 LLMCall + 持久化 ——
    await manageSegment(
      state,
      deps,
      systemPrompt,
      tools,
      requestStartTime,
      totalLatency,
      collected.usage,
      collected.text,
      collected.thinking,
      collected.truncated,
      collected.firstTokenTime,
      contextWindow,
      computedCost,
    )
    yield { _tag: 'llm_detail' }

    if (collected.hadError) {
      state.status = { _tag: 'stopped', reason: 'error' }
      return
    }

    // 过滤掉无效 tool call（id 或工具名为空）。部分输出不规范的 provider
    // 会把单个 tool call 的 arguments 流式片段拆成多个独立 delta，每片
    // id/name 为空——这些碎片无法执行，且其空 id 在下一轮发回 provider 时
    // 触发 "invalid tool_call_id"。这里在持久化/执行前将其丢弃。
    const validToolCalls = Array.from(collected.toolCalls.values()).filter(
      (c) => c.id.length > 0 && c.tool.length > 0,
    )

    // 区分入参解析成功 / 失败的调用。解析失败（模型输出不完整 JSON，常见于流被截断）
    // 的调用对系统完全透明：不执行、不持久化、不发前端事件（见 persistAssistantAndTools），
    // 仅保留解析成功的调用供执行与持久化，避免 _raw/_parseError 容错标记泄漏。
    const validCalls: CollectedToolCall[] = validToolCalls.filter(
      (tc) => !isParseErrorInput(tc.input),
    )

    // —— 压缩退化监测（spec: degradation-monitor）——
    // 压缩成功后监测接下来若干轮 assistant 回复：连续产生空回复（无实质文本且
    // 无 tool_call）说明 agent 可能在"沉默退化"。仅发警告、不中断循环、不设
    // hadError；remaining 耗尽即清除监测器。有 tool_call 的轮次不算退化
    // （正常的工具调用轮次不是"沉默"）。参考 progress guard 的非致命 error 模式。
    const monitor = state.postCompactionMonitor
    if (monitor && monitor.remaining > 0) {
      const replyText = collected.text.join('').trim()
      const noMeaningfulOutput = replyText.length < 10 && validCalls.length === 0
      if (noMeaningfulOutput) {
        monitor.noTextStreak += 1
      }
      monitor.remaining -= 1
      if (monitor.noTextStreak >= 3) {
        yield {
          _tag: 'error',
          error: {
            _tag: 'unexpected',
            message:
              'Agent may be degraded after compaction (no meaningful output for 3 consecutive turns)',
          },
        }
      }
      if (monitor.remaining === 0) {
        state.postCompactionMonitor = undefined
      }
    }

    // —— 持久化 assistant + 执行工具 + 透传 tool_call/subagent 事件 ——
    yield* persistAssistantAndTools(state, deps, collected.text, validCalls)

    // —— 处理 assistant 文本中的 <todo:*> 标签 ——
    yield* processTodoTags(state, collected.text.join(''))

    if (validToolCalls.length === 0) {
      // finish_reason=length/content_filter 表示响应被截断或被内容过滤，而非正常说完。
      // 若当作 completed，被截断的半截回答会静默成功（用户看到"中断但无报错"）。
      if (collected.truncated !== null) {
        const message =
          collected.truncated === 'length'
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
    if (collected.usage && collected.usage.inputTokens > 0) {
      const estimatedRequest =
        estimateTokens(systemPrompt) +
        tools.reduce((sum, t) => sum + estimateTokens(JSON.stringify(t)), 0) +
        estimateTokens(JSON.stringify(chatMessages))
      state.calibrationFactor = calibrateEstimate(
        state.calibrationFactor,
        estimatedRequest,
        collected.usage.inputTokens,
      )
    }
    state.tokenBudget.used = estimateBudget(latestMessages, state.calibrationFactor)
    state.messages = latestMessages

    // —— 轮末压缩（turn-end 自动压缩 + mid-turn 压缩）——
    yield* runCompactionIfNeeded(state, deps, latestMessages)
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
