import { chatStream as llmChatStream } from '../llm/provider.js'
import { resolveRoute } from '../llm/registry.js'
import { detectProjectInfo } from '../project/detect.js'
import { entriesToChatMessages, getSessionContext } from '../session/context.js'
import { getMessages } from '../session/message.js'
import { estimateTokens } from '../session/token.js'
import type { AgentEvent, AgentState } from '../shared/types/agent.js'
import type { ChatRequest, ChatTool } from '../shared/types/llm.js'
import { calibrateEstimate, createTokenBudget, estimateBudget } from './context.js'
import { runCompactionIfNeeded } from './loop/compaction.js'
import { persistAssistantAndTools } from './loop/persist.js'
import { manageSegment } from './loop/segment.js'
import {
  collectStreamChunks,
  isParseErrorInput,
  type StreamCollectResult,
} from './loop/stream-collect.js'
import { processTodoTags } from './loop/todo.js'
import { DEFAULT_EDIT_MODE, getToolMetrics, selectBestMode } from './metrics.js'
import {
  buildDynamicPrompt,
  createPromptRegistry,
  registerPromptSection,
} from './prompt-registry.js'
import { drainSteering } from './steering.js'
import type { CollectedToolCall } from './tool-exec.js'
import type { AgentDependencies } from './types.js'

export { compactContext } from './loop/compaction.js'
export { runSubAgent } from './loop/subagent.js'

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
