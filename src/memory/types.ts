// Sharpshooter 跨会话项目决策记忆（移植自 oh-my-pi packages/coding-agent/src/sharpshooter）。
//
// 管线两段式：
//  1. 提取（extract.ts）：每条用户 prompt 异步单发 LLM，产出 SharpshooterDelta
//     落入按会话分目录的队列（storage.ts，file-per-delta，生产者无锁）；
//  2. 整合（consolidate.ts）：周期调度，把全部队列 delta 一次性整文件重写进
//     三个决策文件（SHARPSHOOTER_MEMORY_FILES），随后消费 delta 文件。
// 记忆「以摩擦换取」：只有回归/反复纠正/隐性不变式级别的决策值得跨会话保留，
// 一次性做完即对的决策由代码自身承载，不进记忆。

/** delta 可主张的决策类别。整合阶段把它们映射进三个记忆文件。 */
export type SharpshooterDeltaKind =
  | 'architecture_decision'
  | 'product_decision'
  | 'style_decision'
  | 'constraint'
  | 'rejected_approach'
  | 'correction'

/** delta 出处：用户 prompt 直说，或借助上文（"选 2"、"就这么办"）消解的短回复。 */
export type SharpshooterDeltaSource = 'explicit_user' | 'contextual_resolution'

/** 提取阶段逐条打的摩擦标签。整合阶段按摩擦谱系（而非决策存在与否）决定收录。 */
export interface SharpshooterFriction {
  /** 用户在纠正/重申此前已定的事。 */
  corrective: boolean
  /** 用户报告之前正常的行为坏了/漂移了。 */
  regression: boolean
  /** 新 agent 只看代码大概率会弄错的隐性不变式。 */
  subtle: boolean
}

/** 一条已提取的决策 delta；入队后等待整合消费。 */
export interface SharpshooterDelta {
  v: 1
  kind: SharpshooterDeltaKind
  /** 无时间性的规范陈述；不含任务状态/路径/符号名。 */
  statement: string
  /** 用户明确拒绝过的替代方案（拒绝本身是决策的一部分时）。 */
  rejectedAlternative?: string
  /** 用户给出理由时的简短「因为」从句。 */
  rationale?: string
  source: SharpshooterDeltaSource
  /** 触发 prompt 的精确子串；宿主侧的准入闸（不存在即丢弃）。 */
  evidence: string
  friction: SharpshooterFriction
  /** 产出该 delta 的会话；整合阶段按此分组。 */
  sessionId: string
  /** 提取时刻（epoch ms）；会话内排序用。 */
  ts: number
}

/** 三个决策文件，按注入顺序。 */
export const SHARPSHOOTER_MEMORY_FILES = ['architecture.md', 'product.md', 'style.md'] as const

export type SharpshooterMemoryFile = (typeof SHARPSHOOTER_MEMORY_FILES)[number]

/** 单文件行数硬上限的默认值（config.memory.sharpshooter.maxFileLines 可覆写）。 */
export const SHARPSHOOTER_MAX_FILE_LINES = 120

/** bank 目录下 state.json 的整合簿记。 */
export interface SharpshooterState {
  v: 1
  /** 最近一次完成（或空队列）整合的时刻（epoch ms）。 */
  lastConsolidatedAt: number
  /** 最近一次成功 apply 的摘要（诊断/状态展示用）。 */
  lastResult?: {
    at: number
    sessions: number
    deltas: number
    model: string
  }
  /** 最近一次整合失败（退避与 /memory 诊断用）。 */
  lastError?: {
    at: number
    message: string
    /** 自上次成功以来的连续失败次数；缺省按 1 计。 */
    failures?: number
  }
}
