// @ 提及候选：键盘索引空间与渲染列表的唯一来源。
//
// 此前 Composer（键盘导航）与 AtFilePopover（渲染）各算一份：渲染只画前
// 20 个文件，键盘却按完整搜索结果计数（/api/files/search 无 limit，真实仓库
// 里 `@src`/`@a` 一命中几百个）。于是 ↓ 按过第 20 项后没有任何项处于高亮
// （aria-selected 无 true、usePopoverScroll 无可滚动目标），而 Enter 仍按
// 完整列表取第 21 项——把一个用户从未看见的文件静默插进 prompt。

import { subsequenceMatch } from '@shared/utils/string.js'
import { atEntryScore } from '@/composer/at-completion.js'
import type { FileSearchResult } from '@/hooks/useFiles.js'
import type { AgentListItem } from '@/services/agent.js'

/** @ agent 段最多展示数（与浮层渲染一致）。 */
export const AT_MAX_SUBAGENTS = 5
/** @ 文件段最多展示数（目录候选与文件共享该上限）。 */
export const AT_MAX_FILES = 20

export type AtMenuItems = {
  /** @agent 段（可调用 subagent/all），过滤 name 后取前 N 个。 */
  subagents: AgentListItem[]
  /** 文件段（含目录候选），只取前 N 个。 */
  files: FileSearchResult[]
}

/**
 * @ 提及候选：纯函数，渲染与键盘共用同一份。
 *
 * - `results` 为服务端搜索结果（walk 序，目录与文件混排）——目录候选也进入
 *   浮层（接受目录 = 链式下钻，见 useComposer.insertAtDirectory），不再被丢弃。
 * - `stale`（react-query placeholderData：新查询在途、results 是上一查询的）时，
 *   先按 query 的子序列匹配收窄旧列表（oh-my-pi atCompletionMatches 口径），
 *   浮层逐字收窄而不是闪「搜索中」。新鲜结果由服务端子串匹配保证含 query，
 *   不重复过滤。
 * - 排序：atEntryScore 分层（目录下钻直接子项 / basename 精确 / basename 前缀 /
 *   路径包含 / 子序列）降序，同分目录在前，再以稳定排序保持来源顺序。
 * - 空 query（裸 `@`）不列文件：服务端空查询不搜索（useFileSearch enabled=false），
 *   旧查询的残留结果也不得借 placeholderData 混进来。
 */
export function atMenuItems({
  agents,
  results,
  query,
  stale = false,
}: {
  agents: AgentListItem[]
  results: FileSearchResult[]
  query: string
  /** results 是否为上一查询的在途残留（新查询尚未返回）。 */
  stale?: boolean
}): AtMenuItems {
  const subagents = agents
    .filter((a) => a.mode !== 'primary')
    .filter((a) => !query || a.name.includes(query))
    .slice(0, AT_MAX_SUBAGENTS)
  if (!query) return { subagents, files: [] }

  const lowerQuery = query.toLowerCase()
  const pool = stale
    ? results.filter((r) => subsequenceMatch(lowerQuery, r.path.toLowerCase()))
    : results
  const files = pool
    .map((r) => ({ r, score: atEntryScore(query, r.path) }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      const aDir = a.r.type === 'directory' ? 0 : 1
      const bDir = b.r.type === 'directory' ? 0 : 1
      return aDir - bDir
    })
    .map((e) => e.r)
    .slice(0, AT_MAX_FILES)
  return { subagents, files }
}

/** 扁平索引 → 候选项：下标落在 agent 段还是文件段由 subagents.length 决定。 */
export function atMenuSelection(
  items: AtMenuItems,
  index: number,
): { kind: 'agent'; agent: AgentListItem } | { kind: 'file'; file: FileSearchResult } | null {
  if (index < 0) return null
  if (index < items.subagents.length) {
    const agent = items.subagents[index]
    return agent ? { kind: 'agent', agent } : null
  }
  const file = items.files[index - items.subagents.length]
  return file ? { kind: 'file', file } : null
}
