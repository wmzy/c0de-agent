import { chatStream as llmChatStream } from '../llm/provider.js'
import { isLLMError } from '../llm/schema/errors.js'
import { entriesToChatMessages, getSessionContext } from '../session/context.js'
import { appendMessage, getMessages } from '../session/message.js'
import { appendLLMDetail } from '../session/session.js'
import { generateId } from '../shared/index.js'
import type { AgentEvent, AgentState, LLMDetail } from '../shared/types/agent.js'
import type { ChatRequest, ChatTool, StreamChunk } from '../shared/types/llm.js'
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

function toolResultToContent(toolName: string, result: ToolResult): MessageContent[] {
  return [{ _tag: 'tool_result', id: generateId(), tool: toolName, output: result }]
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
        projectInfo: {
          name: 'project',
          language: 'TypeScript',
          rootDir: deps.cwd,
        },
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
            collectedToolCalls.set(chunk.id, {
              id: chunk.id,
              tool: chunk.name,
              input: {},
            })
            toolCallArgs.set(chunk.id, '')
            yield {
              _tag: 'tool_call_start',
              id: chunk.id,
              tool: chunk.name,
              input: {},
            }
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
            } catch {
              parsed = { _raw: finalArgs }
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
      cost: 0,
    }
    state.llmDetails.push(detail)
    // 持久化到 sessions.metadata.llmDetails，供会话结束后仍可查看调用详情。
    await appendLLMDetail(deps.db, state.session.id, detail)

    if (hadError) {
      state.status = { _tag: 'stopped', reason: 'error' }
      return
    }

    const assistantContent: MessageContent[] = []
    if (collectedText.length > 0) {
      assistantContent.push({ _tag: 'text', text: collectedText.join('') })
    }
    for (const tc of collectedToolCalls.values()) {
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

    if (collectedToolCalls.size > 0) {
      const calls = Array.from(collectedToolCalls.values())
      if (calls.length > 1) {
        yield {
          _tag: 'tool_calls_parallel',
          calls: calls.map((c) => ({ id: c.id, tool: c.tool, input: c.input })),
        }
      }
      const results = await executeToolCalls(
        deps.toolRegistry,
        deps.permission,
        {
          cwd: deps.cwd,
          session: { id: state.session.id, cwd: deps.cwd },
          abort: state.abortController.signal,
        },
        calls,
        deps.hookRunner,
      )
      for (const { id, result } of results) {
        yield { _tag: 'tool_call_end', id, result }
        const tc = calls.find((c) => c.id === id)
        if (tc) {
          await appendMessage(deps.db, state.session.id, {
            role: 'tool',
            content: toolResultToContent(tc.tool, result),
          })
        }
      }
    }

    if (collectedToolCalls.size === 0) {
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
