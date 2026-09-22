// 回收站会话树的纯函数：从「已删除会话列表」统计某会话的派生后代。
//
// 抽成模块级纯函数（此前内联在 RecycleBin 组件里）：环守卫需要可单测——
// parentId 成环数据（快照恢复 / 手改 DB 均可产生，见 session.ts 的同型守卫注释）
// 会让朴素栈遍历在环上无限打转，而计数在渲染期按行调用 → 页面冻结、标签页无响应。
//
// 索引与计数分离：组件每次渲染建一次索引，逐行计数只读索引（O(n) 建 + O(后代数)
// 计数），不在每行重建映射。

import type { Session } from '@shared/types/message.js'

/** parentId → 子会话列表（只收已删除列表内、有父的条目）。 */
export type DeletedTreeIndex = ReadonlyMap<string, readonly Session[]>

/** 建索引：parentId → 其（已删除）子会话列表。 */
export function buildDeletedTreeIndex(sessions: readonly Session[]): DeletedTreeIndex {
  const byParent = new Map<string, Session[]>()
  for (const s of sessions) {
    if (!s.parentId) continue
    const list = byParent.get(s.parentId)
    if (list) list.push(s)
    else byParent.set(s.parentId, [s])
  }
  return byParent
}

/**
 * 会话在回收站内的派生后代数量（任意深度）。
 * 环守卫：已访问集合使环上节点各计一次后终止——与 session.ts 的
 * orderSessionsByParent / restoreSessionCore / purgeDeletedSessions 同口径。
 * 起点自身不计入（visited 预置 id）。
 */
export function countDeletedDescendants(index: DeletedTreeIndex, id: string): number {
  const visited = new Set<string>([id])
  let count = 0
  const stack = [...(index.get(id) ?? [])]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (!cur || visited.has(cur.id)) continue
    visited.add(cur.id)
    count += 1
    stack.push(...(index.get(cur.id) ?? []))
  }
  return count
}
