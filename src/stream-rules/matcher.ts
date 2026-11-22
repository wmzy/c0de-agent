// 流规则检查器：累积流缓冲 → 对 scope='text' 规则做正则匹配 → repeat 门控。
//
// loop 侧契约（core/loop/stream-collect.ts）：每个 text delta 调
// checkTextDelta；命中即中断本轮流、丢弃输出、injection 注入 steering 同
// turn 重试；每轮流结束（或命中后）调 resetStream。
//
// 匹配策略刻意从简：每次 delta 对滚动窗口全量 test（窗口上限 64K、规则数
// 少，正则 test 微秒级），不移植 omp 的 ConditionTraits 增量分析——正确性
// 优先于微优化，后续窗口成为热点再引入。

import type { StreamRuleChecker, StreamRuleMatch } from '../core/types.js'
import type { StreamRule } from './types.js'

/** 流缓冲滚动窗口上限（UTF-16 code units，64K）。超限丢最旧内容：被丢文本
 *  不再触发规则，截断边界处的跨界匹配也随之丢失——属滚动窗口固有语义。 */
export const STREAM_BUFFER_LIMIT = 65_536

/** 渲染注入文本（omp ttsr-interrupt 语义：告知模型刚才的输出因违反规则被
 *  中断，重试时须遵守 body 指引；body 即规则文件的正文）。 */
export function renderStreamRuleInjection(rule: StreamRule): string {
  return `<stream-rule name="${rule.name}">\n${rule.body}\n</stream-rule>`
}

type RuleState = {
  rule: StreamRule
  /** 上次命中（无论是否过门控被上报）所在流编号；null=从未命中。
   *  被门控吞掉的命中也刷新此值：持续违规不放宽 turn-gap。 */
  lastHitStream: number | null
  /** once 模式已上报标记。 */
  triggered: boolean
  /** 本流内已上报（loop 命中即断流，防御 delta 继续到达时的重复上报）。 */
  reportedThisStream: boolean
}

/** repeat 门控：once=进程内一次；turn-gap=距上次命中 ≥ repeatGap 个流；always=恒可。 */
function gatePasses(state: RuleState, streamCount: number): boolean {
  if (state.rule.repeatMode === 'once') return !state.triggered
  if (state.rule.repeatMode === 'always') return true
  return state.lastHitStream === null || streamCount - state.lastHitStream >= state.rule.repeatGap
}

export function createStreamRuleChecker(rules: StreamRule[]): StreamRuleChecker {
  const states: RuleState[] = rules.map((rule) => ({
    rule,
    lastHitStream: null,
    triggered: false,
    reportedThisStream: false,
  }))
  let buffer = ''
  let streamCount = 0

  return {
    checkTextDelta(delta: string): StreamRuleMatch | null {
      if (states.length === 0 || delta.length === 0) return null
      buffer += delta
      if (buffer.length > STREAM_BUFFER_LIMIT)
        buffer = buffer.slice(buffer.length - STREAM_BUFFER_LIMIT)

      // 规则表顺序即优先级：首个过门控的命中即返（未过门控的命中记录后继续找）
      for (const state of states) {
        if (state.reportedThisStream) continue
        if (!state.rule.conditions.some((condition) => condition.test(buffer))) continue
        // 先判门控再记录：turn-gap 首次命中时 lastHitStream 仍为 null，先覆盖会自我压制
        const passes = gatePasses(state, streamCount)
        state.lastHitStream = streamCount
        if (!passes) continue
        state.triggered = true
        state.reportedThisStream = true
        return { ruleName: state.rule.name, injection: renderStreamRuleInjection(state.rule) }
      }
      return null
    },

    resetStream(): void {
      buffer = ''
      streamCount += 1
      for (const state of states) state.reportedThisStream = false
    },
  }
}
