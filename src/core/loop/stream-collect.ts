import type { chatStream as llmChatStream } from '../../llm/provider.js'
import { isContextOverflowFailure } from '../../llm/provider-error.js'
import { isLLMError } from '../../llm/schema/errors.js'
import type { AgentEvent, AgentState } from '../../shared/types/agent.js'
import type { ChatRequest, FinishReason, StreamChunk } from '../../shared/types/llm.js'
import type { LoopDeps } from '../loop.js'
import type { CollectedToolCall } from '../tool-exec.js'
import { recoverFromOverflow } from './compaction.js'

/** 入参是否为协议层/loop 标记的解析失败（携带 _parseError / _raw 容错标记）。
 * 这类入参是后端专用、只反馈给模型重试的，绝不能进入持久化消息或渲染层。 */
export function isParseErrorInput(input: unknown): boolean {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false
  const obj = input as Record<string, unknown>
  return '_parseError' in obj || '_raw' in obj
}

/** collectStreamChunks 的收集结果：单轮 LLM 流的全部产出与状态标记。 */
export type StreamCollectResult = {
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
export async function* collectStreamChunks(
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
