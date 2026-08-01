import { createKanbanStore } from '../../kanban/index.js'
import { appendMessage } from '../../session/message.js'
import type { AgentEvent, AgentState } from '../../shared/types/agent.js'
import type { MessageContent } from '../../shared/types/message.js'
import type { ToolResult } from '../../shared/types/tool.js'
import type { LoopDeps } from '../loop.js'
import { inferToolMode, recordToolMetrics } from '../metrics.js'
import type { CollectedToolCall } from '../tool-exec.js'
import { executeToolCalls } from '../tool-exec.js'
import { runSubAgent } from './subagent.js'

function toolResultToContent(
  toolCallId: string,
  toolName: string,
  result: ToolResult,
): MessageContent[] {
  return [{ _tag: 'tool_result', id: toolCallId, tool: toolName, output: result }]
}

/** 持久化 assistant 消息 + 执行工具调用 + 持久化 tool result + 记录 metrics，
 *  并透传 tool_call_start/tool_call_end/subagent 事件。
 *
 *  - 仅持久化/执行解析成功的调用（isParseErrorInput 过滤容错标记，避免 _raw/_parseError 落库）。
 *  - tool_call_start 仅在入参解析完成后、携带真实入参时发射（前端拿到的第一帧即完整入参）。
 *  - subagent 事件缓冲（runSubAgent → eventSink）在工具执行后 yield 出去（spec §4.5 step 7）。
 *  - metrics 记录为 fire-and-forget，失败绝不阻塞 agent 主流程。 */
export async function* persistAssistantAndTools(
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
