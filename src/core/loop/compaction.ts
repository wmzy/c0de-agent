import { getMessages } from '../../session/message.js'
import type { AgentEvent, AgentState } from '../../shared/types/agent.js'
import type { Message } from '../../shared/types/message.js'
import { createSummarizer, runCompaction } from '../compact.js'
import { estimateBudget, shouldCompact } from '../context.js'
import type { LoopDeps } from '../loop.js'

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
export async function recoverFromOverflow(state: AgentState, deps: LoopDeps): Promise<boolean> {
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

/** 轮末压缩：turn-end 自动压缩（含死锁检测）+ mid-turn 压缩，复用 compactContext。
 *
 *  - turn-end：shouldCompact 触发时静默压缩；压缩后仍超阈值（典型成因 keepRecentTokens
 *    本身已超 historyBudget）则标记死锁暂停后续自动压缩，并发出非致命警告（不中断循环）。
 *    死锁在下一轮用户输入（agentLoop 重入）时重置。
 *  - mid-turn：midTurnEnabled 单独 opt-in（默认关闭）时按 enabled:true 阈值静默压缩，
 *    复用 shouldCompact 逻辑但不发 error/warning，压缩后刷新内存消息视图。
 *  两者都静默消费 compactContext 的 text_delta 通知（不透传给用户）。 */
export async function* runCompactionIfNeeded(
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
