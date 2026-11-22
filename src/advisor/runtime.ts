// Advisor 影子审查运行时（最小版）：core/loop 在每个 tool round 持久化后
// fire-and-forget 调 onTurnEnd，这里渲染增量 → 单发 LLM（advise 工具，
// toolChoice required）→ emission-guard 准入 → 每条准入 note 调 onNote
// （组装点通常桥 injectSteering，把 note 在下一 turn 边界合入主 agent）。
//
// 铁律：advisor 是纯旁路——任何错误只 logger.warn 吞掉，绝不影响主循环；
// 审查经共享串行 runner（memory/wiring，同 sharpshooter 提取链）串行化
// （不叠请求、顺序确定），保证 emission-guard 的 update 计数与 LLM 返回顺序一致。

import { getLogger } from '../core/logger.js'
import type { AdvisorRuntime } from '../core/types.js'
import type { Registry } from '../llm/registry.js'
import { callToolRequired, type MemoryLlmCall } from '../memory/llm-call.js'
import { createLazyRegistry, createSerialRunner } from '../memory/wiring.js'
import type { Config } from '../shared/types/config.js'
import type { ChatTool } from '../shared/types/llm.js'
import { errorMessage } from '../shared/utils/string.js'
import { AdvisorEmissionGuard } from './emission-guard.js'
import { createDeltaRenderer } from './render.js'
import { type AdvisorSettings, resolveAdvisorSettings } from './settings.js'
import type { AdvisorNote, AdvisorSeverity } from './types.js'

const logger = getLogger('advisor.runtime')

/** advise 工具（omp advise-tool 同款 schema）：note 必填、severity 缺省 nit。
 *  toolChoice required 逼模型以结构化工具调用产出，不靠解析自由文本。 */
const ADVISE_TOOL: ChatTool = {
  name: 'advise',
  description:
    'Send one concrete finding about the agent you are watching. Stay silent (no call) when nothing matters.',
  parameters: {
    type: 'object',
    properties: {
      note: {
        type: 'string',
        description:
          'One concrete, terse, actionable piece of advice for the agent you are watching.',
      },
      severity: {
        type: 'string',
        enum: ['nit', 'concern', 'blocker'],
        description: 'How strongly to weigh this. Omit for a plain nit.',
      },
    },
    required: ['note'],
  },
}

/** 审查单发的输出上限：advise note 是短句，无需大预算。 */
const ADVISOR_MAX_TOKENS = 1024

/** getNotes 累积上限（诊断/测试视角）：FIFO 界定，防止长会话无界增长。 */
const MAX_RETAINED_NOTES = 200

/** 审查系统提示（omp advisor system.md 的最小化）：角色 + 准入规则 + 分级
 *  标准。预算数字写进提示词让模型自律，闸门在代码里兜底（见 emission-guard）。 */
function advisorSystemPrompt(settings: AdvisorSettings): string {
  return [
    "You are the advisor: a shadow reviewer watching a coding agent's session transcript.",
    'Review each session update and call `advise` with concrete findings about the watched',
    "agent's work — correctness risks, wrong direction, missed constraints, premature",
    'completion claims, wasteful detours. Address the agent directly; offer alternatives,',
    'not lectures.',
    '',
    'Rules:',
    `- Silence is preferred when the agent is on track: call \`advise\` only when something`,
    `  matters. Max ${settings.maxNotesPerUpdate} non-blocker notes per update (\`blocker\` exempt).`,
    '- NEVER restate information the agent already has (seen errors, diagnostics, failed builds/tests).',
    '- NEVER repeat advice you already gave; allow action before revisiting its theme. Re-raising',
    '  prior non-blocker advice as `blocker` is allowed only when new transcript evidence qualifies.',
    '- `nit`: non-urgent cleanup, missed opportunity. `concern`: agent may head wrong or miss a',
    '  material issue. `blocker`: continuing contradicts an explicit user instruction or will',
    '  clearly require user intervention later.',
    '- Advise only on concrete technical risk or transcript-evident execution failure; generic',
    '  uncertainty or user-intent ambiguity means SILENT. Never tell the agent to seek',
    '  clarification or confirm scope — intent belongs to the main agent.',
    '- Do not police scope or ambition (large diffs may be exactly what the user wants) and do',
    '  not raise backwards compatibility unless the user or a standing project rule requires it.',
    '- Cite transcript evidence for every claim.',
  ].join('\n')
}

/** 解析 advise 工具参数：note 非字符串/空白返回 null；severity 缺省或
 *  非法（模型偶发输出枚举外字符串）一律回退 nit。 */
function parseAdviseArgs(args: unknown): AdvisorNote | null {
  if (typeof args !== 'object' || args === null) return null
  const record = args as { note?: unknown; severity?: unknown }
  if (typeof record.note !== 'string' || record.note.trim() === '') return null
  const severity: AdvisorSeverity =
    record.severity === 'concern' || record.severity === 'blocker' ? record.severity : 'nit'
  return { note: record.note, severity }
}

/** createAdvisorRuntime 的 opts（组装点注入；测试注入 llmCall/now）。 */
export interface AdvisorRuntimeOptions {
  /** 准入 note 的唯一出口：runtime 对每条经闸门的 note 调用一次。组装点
   *  通常桥 injectSteering（severity 决定打断还是下一边界合入）。 */
  onNote: (note: AdvisorNote) => void
  /** 活 registry 获取器（server 传 live registry 感知配置热更）；缺省按
   *  config 自建一次（CLI 短命进程足够，同 sharpshooter 口径）。 */
  getRegistry?: () => Registry
  /** 依赖注入：审查的 LLM 单发调用（测试 fake，不真打 provider）。 */
  llmCall?: MemoryLlmCall
  /** 时钟（测试注入）；用于审查耗时的 debug 日志。 */
  now?: () => number
}

export type AdvisorRuntimeHandle = AdvisorRuntime & {
  /** 停止接受新审查（会话/运行时销毁边界调用；本实现恒存在）。 */
  dispose: () => void
  /** 已准入 note 的只读副本（诊断/测试视角；FIFO 上限 200 条）。 */
  getNotes: () => AdvisorNote[]
}

/** 创建 advisor 运行时。onTurnEnd 同步返回（fire-and-forget）；内部串行
 *  链保证同一时刻至多一趟在途审查。dispose 后不再接新审查（在途一趟的
 *  结果仍会走完 onNote——组装点负责 dispose 时同步摘除注入桥）。 */
export function createAdvisorRuntime(
  config: Config,
  opts: AdvisorRuntimeOptions,
): AdvisorRuntimeHandle {
  const settings = resolveAdvisorSettings(config)
  const now = opts.now ?? Date.now
  const guard = new AdvisorEmissionGuard({
    budgetPerUpdate: settings.maxNotesPerUpdate,
    immuneTurns: settings.immuneTurns,
  })
  const renderer = createDeltaRenderer()
  const system = advisorSystemPrompt(settings)
  const retainedNotes: AdvisorNote[] = []

  const getRegistry = createLazyRegistry(config, opts.getRegistry)

  const llmCall: MemoryLlmCall = opts.llmCall ?? callToolRequired

  // 审查串行链：同会话连发 turn 不叠请求，顺序确定（保证 emission-guard
  // 的 update 计数与 LLM 返回顺序一致）。
  const reviewRunner = createSerialRunner()
  let disposed = false

  async function reviewOnce(input: {
    sessionId: string
    cwd: string
    delta: string
    willContinue: boolean
  }): Promise<void> {
    const startedAt = now()
    const status = input.willContinue
      ? 'The agent is mid-run — more steps follow. Withhold critique of partial work unless it is a blocker on an unrecoverable side effect.'
      : 'The turn has ended — full review applies.'
    const prompt = `${input.delta}\n\n---\nWorking directory: ${input.cwd}\n${status}`
    const result = await llmCall({
      registry: getRegistry(),
      config,
      system,
      input: prompt,
      tool: ADVISE_TOOL,
      maxTokens: ADVISOR_MAX_TOKENS,
      model: settings.model,
    })
    // beginUpdate 必须在串行链内（而非 onTurnEnd）：update 计数与预算槽
    // 的推进顺序和 LLM 实际完成顺序一致，冷却/预算才有确定语义。
    guard.beginUpdate()
    for (const call of result.toolCalls) {
      if (call.name !== 'advise') continue
      const note = parseAdviseArgs(call.arguments)
      if (!note) continue
      const admission = guard.admit(note.note, note.severity)
      if (!admission.accepted) {
        logger.debug(`advisor note suppressed (${admission.reason}): ${note.note.slice(0, 80)}`)
        continue
      }
      retainedNotes.push(note)
      if (retainedNotes.length > MAX_RETAINED_NOTES) retainedNotes.shift()
      opts.onNote(note)
    }
    logger.debug(`advisor review of ${input.sessionId} finished in ${now() - startedAt}ms`)
  }

  return {
    onTurnEnd(input) {
      if (disposed || !settings.enabled) return
      try {
        const delta = renderer.render(input.sessionId, input.messages)
        if (!delta) return
        // 串行化在途审查（同 sharpshooter 提取链）：失败只记日志——审查是
        // 纯旁路，绝不影响主循环。
        reviewRunner.submit(
          () =>
            reviewOnce({
              sessionId: input.sessionId,
              cwd: input.cwd,
              delta,
              willContinue: input.willContinue,
            }),
          (error) => {
            logger.warn(`advisor review failed: ${errorMessage(error)}`)
          },
        )
      } catch (error) {
        logger.warn(`advisor review could not start: ${errorMessage(error)}`)
      }
    },
    dispose() {
      disposed = true
    },
    getNotes: () => [...retainedNotes],
  }
}

/** 把准入 note 渲染成注入主对话的 steering 文本（omp advise-tool 的
 *  <advisory> XML 口径：guidance 属性告诉主模型「权衡采纳，不要盲从」）。 */
export function renderAdvisoryNote(note: AdvisorNote): string {
  return `<advisory severity="${note.severity}" guidance="weigh this note; do not blindly obey">${note.note}</advisory>`
}
