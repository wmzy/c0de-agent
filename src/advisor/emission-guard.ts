// Advisor note 准入闸门（omp advisor/emission-guard.ts 直译精简）。
//
// 为什么要在代码里做而不是写在提示词里：omp #3520 实测 advisor 模型会把
// 「max 4 条/update、不要重复」的提示词约定当耳旁风——病理会话里 309 次
// advise 调用只覆盖 92 条唯一 note（114×「Stop.」、52×「No issue; continue.」），
// 把主 transcript 淹没在任务早已完成后的 blocker 轰炸里。规则必须落在
// 准入边界上成为 load-bearing 代码，主循环才能在 advisor 失控时保持干净。
//
// 与 omp 版的差异（最小版裁剪）：
// - 没有 pending/routed 槽位与 displaced 语义——本版准入即经 onNote 立即
//   注入，投递不可撤回，无需「挤掉仍在排队的前一条」；
// - 新增 immuneTurns 冷却（omp 在 advise-tool 的投递通道层做）：blocker
//   打断后 N 个 update 内非 blocker 一律不注入，给主 agent 留恢复空间。

import type { AdvisorSeverity } from './types.js'

/** 大小写不敏感、折叠标点的归一化：连续非字母数字段折叠为单空格并 trim。
 *  「Stop.」「*Stop*」「  stop  」都归一到 `stop`，使噪声短语表一次成员
 *  判定覆盖全部大小写/标点变体。\p{L}\p{N} 保留 CJK——中文 note 的去重
 *  key 不能被归一化抹成空串。导出供测试。 */
export function normalizeAdvisorNote(note: string): string {
  return note
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** 归一化后的噪声短语表：advisor 偶尔产出的、无具体可行动内容的空泛话。
 *  只收短小的 content-free 填充词（沉默才是「没有意见」的正确表达）；
 *  一条真实的 blocker 如「Stop: writeStream.end() 缺 await 会丢缓冲写」
 *  不会命中。key 必须是 normalizeAdvisorNote 的输出形态。 */
const SUPPRESSED_NORMALIZED_PHRASES: Record<string, true> = {
  // 无理由的「停下」——没有原因的叫停对 agent 毫无用处。
  stop: true,
  'stop here': true,
  'stop now': true,
  halt: true,
  abort: true,
  // 完成自言自语——任务已经结束。
  done: true,
  'task done': true,
  'task complete': true,
  complete: true,
  finished: true,
  ok: true,
  okay: true,
  'ok done': true,
  // 「没什么可说的」——沉默的正确表达就是不调用。
  'no issue': true,
  'no issues': true,
  'no issue continue': true,
  'no concerns': true,
  'no concern': true,
  'nothing to add': true,
  'nothing to flag': true,
  'nothing to report': true,
  'no notes': true,
  'no further input': true,
  'no further input needed': true,
  'no further input required': true,
  'no further advice': true,
  'no further advice needed': true,
  // 空泛背书——等价于沉默。
  lgtm: true,
  'looks good': true,
  'all good': true,
  'agent is on track': true,
  'agent on track': true,
  'on track': true,
  continue: true,
  'carry on': true,
  'continue as planned': true,
}

/** 去重历史上限。omp 病理会话有 92 条唯一 note；4096 留足余量且占用极小
 *  （≤ ~256KB 归一化字符串），防止超长会话的 Set 无界增长。 */
const DEFAULT_HISTORY_CAPACITY = 4096

/** 每 update 非 blocker 准入上限的全局硬顶（跨一切配置）。 */
export const ADVISOR_MAX_BUDGET_PER_UPDATE = 32

/** 每 update 非 blocker 准入上限的缺省值（未配置时）。 */
export const ADVISOR_DEFAULT_BUDGET_PER_UPDATE = 4

/** blocker 打断后的冷却 update 数缺省值。 */
export const ADVISOR_DEFAULT_IMMUNE_TURNS = 3

/** note 被拒绝的真相分类（日志/调试用，拒绝原因绝不谎报）。 */
export type AdvisorSuppressionReason = 'empty' | 'noise' | 'duplicate' | 'cooldown' | 'rate-limit'

/** 单次 admit 的准入决定：accepted=false 时 reason 说明真实拒绝分类。 */
export interface AdvisorAdmission {
  accepted: boolean
  reason?: AdvisorSuppressionReason
}

/** severity → 去重可比较的等级。缺省视作 nit（工具参数契约：severity 可省略）。 */
const SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 }

/** 单会话准入闸门：噪声过滤 → rank-aware 去重 → blocker 冷却 → 每 update
 *  非 blocker 预算。被拒绝的调用不消耗预算——同一 update 里噪声调用不会
 *  烧掉随后真 concern 的名额。
 *
 * 去重是 rank-aware 的：同文本以严格更高级别重发（nit → concern → blocker）
 *  是真实升级，放行——已注入过的 nit 升级成 blocker 仍能打断；同级或降级
 *  重发保持拒绝，advisor 无法靠「换标签重发」绕过去重。 */
export class AdvisorEmissionGuard {
  /** 归一化 key → 本会话已准入的最高等级。仅严格升级（rank 更高）放行。 */
  readonly #seen = new Map<string, number>()
  /** 插入序日志，驱动 FIFO 淘汰（首个准入时入队；升级就地改 rank）。 */
  readonly #seenOrder: string[] = []
  /** 本 update 已占用的非 blocker 预算槽（准入序）。同一 update 内同文本
   *  升级就地改 rank，不占第二个槽。 */
  readonly #slots: { key: string; rank: number }[] = []
  readonly #capacity: number
  readonly #budgetPerUpdate: number
  readonly #immuneTurns: number
  /** 已完成的 update 数（beginUpdate 递增）——冷却窗口的时钟。 */
  #completedUpdates = 0
  /** 最近一次 blocker 准入所在的 update；undefined = 从未打断。 */
  #immuneStart: number | undefined

  constructor(opts: { capacity?: number; budgetPerUpdate?: number; immuneTurns?: number } = {}) {
    this.#capacity =
      typeof opts.capacity === 'number' && Number.isFinite(opts.capacity)
        ? Math.max(1, Math.trunc(opts.capacity))
        : DEFAULT_HISTORY_CAPACITY
    const budget = opts.budgetPerUpdate
    this.#budgetPerUpdate =
      typeof budget === 'number' && Number.isFinite(budget)
        ? Math.min(ADVISOR_MAX_BUDGET_PER_UPDATE, Math.max(1, Math.trunc(budget)))
        : ADVISOR_DEFAULT_BUDGET_PER_UPDATE
    const immune = opts.immuneTurns
    this.#immuneTurns =
      typeof immune === 'number' && Number.isFinite(immune)
        ? Math.max(0, Math.trunc(immune))
        : ADVISOR_DEFAULT_IMMUNE_TURNS
  }

  /** 冷却窗口是否激活：blocker 准入后的接下来 immuneTurns 个 update 内，
   *  非 blocker 一律暂缓注入。blocker 所在 update 本身不算（同批随行 note
   *  与 blocker 一起注入是正常组合，如「停：X 坏了」+「顺带 Y 白费功夫」）。
   *  窗口内再准入新 blocker 会重置窗口起点（最新打断优先）。 */
  #immuneActive(): boolean {
    if (this.#immuneStart === undefined || this.#immuneTurns <= 0) return false
    const elapsed = this.#completedUpdates - this.#immuneStart
    return elapsed > 0 && elapsed <= this.#immuneTurns
  }

  /** 清空全部去重/预算/冷却状态（会话切换、/clear 等重置边界）。 */
  reset(): void {
    this.#seen.clear()
    this.#seenOrder.length = 0
    this.#slots.length = 0
    this.#completedUpdates = 0
    this.#immuneStart = undefined
  }

  /** 开始一个新的 update 周期：清空预算槽并推进冷却时钟。每个审查周期
   *  （对应主循环一次 onTurnEnd）恰好调用一次。 */
  beginUpdate(): void {
    this.#completedUpdates += 1
    this.#slots.length = 0
  }

  /** 记录 key 的最高准入等级并 FIFO 界定历史；admit 的唯一记录路径。 */
  #recordRank(key: string, rank: number): void {
    const isNew = !this.#seen.has(key)
    this.#seen.set(key, rank)
    if (!isNew) return
    this.#seenOrder.push(key)
    if (this.#seenOrder.length > this.#capacity) {
      const stale = this.#seenOrder.shift()
      if (stale !== undefined) this.#seen.delete(stale)
    }
  }

  /** 判定一条 note 是否准入。顺序：空 → 噪声 → 去重 → 冷却 → 预算。
   *  冷却拒绝不记录去重 key——窗口结束后同文本重发仍可正常准入（冷却
   *  语义是「暂缓注入」，不是「已说过」）。accepted=true 时闸门已记录
   *  key、占用预算并在 blocker 时开启冷却窗口。 */
  admit(note: string, severity: AdvisorSeverity): AdvisorAdmission {
    const key = normalizeAdvisorNote(note)
    if (!key) return { accepted: false, reason: 'empty' }
    if (SUPPRESSED_NORMALIZED_PHRASES[key]) return { accepted: false, reason: 'noise' }
    const rank = SEVERITY_RANK[severity]
    const seenRank = this.#seen.get(key) ?? 0
    if (rank <= seenRank) return { accepted: false, reason: 'duplicate' }
    if (severity !== 'blocker' && this.#immuneActive()) {
      return { accepted: false, reason: 'cooldown' }
    }
    const ownSlot = this.#slots.find((s) => s.key === key)
    if (severity === 'blocker') {
      // blocker 免预算（必须总能打断）；同文本此前占的非 blocker 槽释放。
      if (ownSlot) this.#slots.splice(this.#slots.indexOf(ownSlot), 1)
      this.#immuneStart = this.#completedUpdates
    } else if (ownSlot) {
      // 同 update 内升级：改槽等级，不为同文本重复占槽。
      ownSlot.rank = rank
    } else if (this.#slots.length >= this.#budgetPerUpdate) {
      return { accepted: false, reason: 'rate-limit' }
    } else {
      this.#slots.push({ key, rank })
    }
    this.#recordRank(key, rank)
    return { accepted: true }
  }
}
