// @ 提及候选：键盘索引空间与渲染列表的唯一来源。
//
// 此前 Composer（键盘导航）与 AtFilePopover（渲染）各算一份：渲染只画前
// 20 个文件，键盘却按完整搜索结果计数（/api/files/search 无 limit，真实仓库
// 里 `@src`/`@a` 一命中几百个）。于是 ↓ 按过第 20 项后没有任何项处于高亮
// （aria-selected 无 true、usePopoverScroll 无可滚动目标），而 Enter 仍按
// 完整列表取第 21 项——把一个用户从未看见的文件静默插进 prompt。

import type { AgentListItem } from '@/services/agent.js'
import type { FileSearchResult } from '@/types/index.js'

/** @ agent 段最多展示数（与浮层渲染一致）。 */
export const AT_MAX_SUBAGENTS = 5
/** @ 文件段最多展示数（与浮层渲染一致）。 */
export const AT_MAX_FILES = 20

export type AtMenuItems = {
  /** @agent 段（可调用 subagent/all），过滤 name 后取前 N 个。 */
  subagents: AgentListItem[]
  /** @文件段，只取前 N 个。 */
  files: FileSearchResult[]
}

/** @ 提及候选：纯函数，渲染与键盘共用同一份。 */
export function atMenuItems({
  agents,
  results,
  query,
}: {
  agents: AgentListItem[]
  results: FileSearchResult[]
  query: string
}): AtMenuItems {
  return {
    subagents: agents
      .filter((a) => a.mode !== 'primary')
      .filter((a) => !query || a.name.includes(query))
      .slice(0, AT_MAX_SUBAGENTS),
    files: results.filter((r) => r.type === 'file').slice(0, AT_MAX_FILES),
  }
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
