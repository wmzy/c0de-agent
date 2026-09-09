import { usageEvents } from '../../db/schema.js'
import { saveLLMSegments, segmentFingerprint } from '../../session/session.js'
import { generateId } from '../../shared/index.js'
import type { AgentState, LLMCall, LLMSegment, SegmentTrigger } from '../../shared/types/agent.js'
import type { ChatTool, FinishReason } from '../../shared/types/llm.js'
import type { LoopDeps } from '../loop.js'
import type { StreamCollectResult } from './stream-collect.js'

/** 段管理：判断段边界（pending trigger / model / systemPrompt / tools 变化），
 *  构造本轮 LLMCall 并 push 到当前段，持久化 segments。直接修改 state.segments（引用语义）。
 *  trigger 判定用于新段元数据；needSegment 决定是否真正开新段（否则复用 activeSeg）。 */
export async function manageSegment(
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
  /** null = 价格未知（loop 层已判定），按 $0 计入并由聚合层计数提示。 */
  computedCost: number | null,
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

  // P2 成本账本：每个 LLM 调用同时落独立 usage_events 表（与 session 生命周期解耦——
  // 会话物理清除后花费记录仍在，账本不随回收站到期/彻底删除而消失）。
  await deps.db.db
    .insert(usageEvents)
    .values({
      callId: call.id,
      sessionId: state.session.id,
      projectId: state.session.projectId ?? null,
      provider: state.config.provider,
      model: state.config.model,
      inputTokens: call.usage.input,
      outputTokens: call.usage.output,
      cacheRead: call.usage.cacheRead ?? 0,
      cost: computedCost,
      timestamp: call.timestamp,
    })
    .catch((err: unknown) => {
      // 账本写入失败不致命（会话元数据仍含 segments 备份）；告警便于排查。
      console.warn(
        `[loop] usage_events 写入失败（成本账本将缺失本次调用）：${err instanceof Error ? err.message : String(err)}`,
      )
    })
}
