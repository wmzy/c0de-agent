import type { LLMCall, LLMSegment } from '@shared/types/agent.js'
import type { Message } from '@shared/types/message.js'

/** 时间线统一行类型。把消息、LLM 调用、段标记合并为单一有序序列。 */
export type TimelineRow =
  | { kind: 'message'; message: Message; ts: number; latency?: number }
  | { kind: 'call'; call: LLMCall; segment: LLMSegment; ts: number }
  | { kind: 'segment'; segment: LLMSegment; ts: number }

/** 段标记 < call < message：保证段头排在自身 calls 之前、消息之前（同时间戳稳定）。 */
const ORDER: Record<TimelineRow['kind'], number> = { segment: 0, call: 1, message: 2 }

/**
 * 把消息流与 LLM 段/调用合并为按时间排序的统一时间线。
 *
 * Message 与 LLMCall 无共享 id（后端独立生成），无法可靠强配对，故采用时间交错：
 * 段标记按 startedAt 插入，段内 call 按 timestamp 插入。因 call.timestamp 与所在段
 * 的 startedAt 常相等（同一 requestStartTime），用次级 ORDER 保证段头在前、call 次之、
 * message 靠后（assistant 消息 createdAt 恒不早于产生它的调用）。失败调用（hadError
 * 时只记 call 不存 message）会作为无后续消息的孤立 call 行出现——这正是需被露出的
 * 「隐藏条目」。
 */
export function buildTimeline(messages: Message[], segments: LLMSegment[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  for (const message of messages) {
    rows.push({ kind: 'message', message, ts: message.createdAt })
  }
  for (const segment of segments) {
    rows.push({ kind: 'segment', segment, ts: segment.startedAt })
    for (const call of segment.calls) {
      rows.push({ kind: 'call', call, segment, ts: call.timestamp })
    }
  }
  rows.sort((a, b) => a.ts - b.ts || ORDER[a.kind] - ORDER[b.kind])

  // latency 配对：assistant 消息配对 timestamp ≤ msg.ts 的最近未消费 call。
  // agent loop 严格串行（call 结束→持久化 msg→下一 call），故 msg.ts 恒落在
  // [call.ts, next_call.ts) 内。双指针线性扫描 O(N+M)。
  const allCalls = segments.flatMap((s) =>
    s.calls.map((c) => ({ call: c, segStartedAt: s.startedAt })),
  )
  let callIdx = 0
  const consumed = new Set<string>()
  for (const row of rows) {
    if (row.kind !== 'message') continue
    if (row.message.role !== 'assistant') continue
    // 推进到不超过 msg.ts 的最后一个未消费 call
    let best: { call: LLMCall; segStartedAt: number } | null = null
    while (callIdx < allCalls.length && allCalls[callIdx]!.call.timestamp <= row.ts) {
      const candidate = allCalls[callIdx]!
      if (!consumed.has(candidate.call.id)) {
        best = candidate
      }
      callIdx++
    }
    if (best && !consumed.has(best.call.id)) {
      consumed.add(best.call.id)
      row.latency = best.call.latency.total
    }
  }
  return rows
}

export type SegmentGroup = {
  segment: LLMSegment
  messages: { message: Message; latency?: number }[]
  isFirst: boolean
}

/**
 * 把扁平 TimelineRow[] 按 segment 行切分为有序分组，供 TimelineChat 消费。
 * call 行被丢弃（chat 不渲染）；message 行收入对应段。
 * segments 为空时，所有消息归入单个隐式组（isFirst=true，无 segment 数据）。
 */
export function groupBySegment(rows: TimelineRow[]): SegmentGroup[] {
  const groups: SegmentGroup[] = []
  let current: SegmentGroup | null = null

  for (const row of rows) {
    if (row.kind === 'segment') {
      if (current) groups.push(current)
      current = { segment: row.segment, messages: [], isFirst: groups.length === 0 }
    } else if (row.kind === 'message') {
      if (!current) {
        // segment 行之前的消息：创建隐式首段
        current = {
          segment: {
            id: '__implicit__',
            fingerprint: '',
            provider: '',
            model: '',
            systemPrompt: '',
            tools: [],
            startedAt: row.ts,
            trigger: 'initial',
            calls: [],
          },
          messages: [],
          isFirst: true,
        }
      }
      current.messages.push({ message: row.message, latency: row.latency })
    }
    // call 行：跳过（chat 不渲染）
  }
  if (current) groups.push(current)
  return groups
}

/** 美化聊天视图下默认隐藏的空壳消息（无任何 content part）。 */
export function isEmptyMessage(message: Message): boolean {
  return message.content.length === 0
}
