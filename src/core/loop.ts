import { chatStream as llmChatStream } from '../llm/provider.js'
import { resolveRoute } from '../llm/registry.js'
import { isLLMError } from '../llm/schema/errors.js'
import { detectProjectInfo } from '../project/detect.js'
import { entriesToChatMessages, getSessionContext } from '../session/context.js'
import { appendMessage, getMessages } from '../session/message.js'
import { appendLLMDetail } from '../session/session.js'
import { generateId } from '../shared/index.js'
import type { AgentEvent, AgentState, LLMDetail } from '../shared/types/agent.js'
import type { ChatRequest, ChatTool, FinishReason, StreamChunk } from '../shared/types/llm.js'
import type { MessageContent } from '../shared/types/message.js'
import type { ToolResult } from '../shared/types/tool.js'
import { createSummarizer, runCompaction } from './compact.js'
import { estimateBudget, shouldCompact } from './context.js'
import { buildSystemPrompt } from './prompt.js'
import { drainSteering } from './steering.js'
import type { CollectedToolCall } from './tool-exec.js'
import { executeToolCalls } from './tool-exec.js'
import type { AgentDependencies } from './types.js'

type LoopDeps = AgentDependencies & {
  chatStream?: typeof llmChatStream
}

export type { LoopDeps }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForResume(state: AgentState): Promise<void> {
  while (true) {
    await sleep(100)
    if (state.status._tag !== 'paused') return
  }
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

    const systemPrompt =
      state.config.systemPrompt ??
      buildSystemPrompt({
        tools: state.tools,
        config: state.config,
        projectInfo: detectProjectInfo(deps.cwd),
        skills: [],
      })

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
    // 的调用不执行、不持久化为 assistant tool_call、也不向前端发 tool_call_start——
    // 仅把错误作为 tool result 反馈给模型让其重试，避免 _raw/_parseError 等容错
    // 标记泄漏到持久化消息与渲染层。对齐 oh-my-pi 的 __parseError 容错。
    const validCalls: CollectedToolCall[] = []
    const parseErrorCalls: CollectedToolCall[] = []
    for (const tc of validToolCalls) {
      if (isParseErrorInput(tc.input)) parseErrorCalls.push(tc)
      else validCalls.push(tc)
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

    if (validToolCalls.length > 0) {
      // 解析失败的调用：组装可读的错误 result 反馈给模型（不含 [object Object]，
      // 不直接平铺原始片段作为参数）。参考 oh-my-pi 的 __parseError 处理。
      const parseErrorResults: { id: string; result: ToolResult }[] = parseErrorCalls.map((tc) => {
        const errInput = tc.input as { _parseError?: unknown; _raw?: unknown }
        const rawSnippet = typeof errInput._raw === 'string' ? errInput._raw.slice(0, 200) : ''
        return {
          id: tc.id,
          result: {
            _tag: 'error',
            error: `工具 "${tc.tool}" 的参数不是合法 JSON，已跳过执行并要求模型重试。原始输出片段：${rawSnippet || '(空)'}`,
          },
        }
      })
      const results =
        validCalls.length > 0
          ? await executeToolCalls(
              deps.toolRegistry,
              deps.permission,
              {
                cwd: deps.cwd,
                session: { id: state.session.id, cwd: deps.cwd },
                abort: state.abortController.signal,
              },
              validCalls,
              deps.hookRunner,
            )
          : []
      results.push(...parseErrorResults)
      for (const { id, result } of results) {
        yield { _tag: 'tool_call_end', id, result }
        const tc = validToolCalls.find((c) => c.id === id)
        if (tc) {
          await appendMessage(deps.db, state.session.id, {
            role: 'tool',
            content: toolResultToContent(id, tc.tool, result),
          })
        }
      }
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
    state.tokenBudget.used = estimateBudget(latestMessages)
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
        state.tokenBudget.used = estimateBudget(await getMessages(deps.db, state.session.id))
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
