import type { KanbanCard } from '@/services/kanban.js'

/** 与后端 kanban store 的 POSITION_GAP 一致（拖拽中点插入的半距）。 */
const POSITION_GAP = 1000

/**
 * 计算拖放落到**另一张卡片**上时的目标 position（列内重排）。
 *
 * 语义必须与 dnd-kit 的拖拽预览一致：拖动中 `verticalListSortingStrategy` 把被拖
 * 卡片画在 over 卡片的槽位上、区间内的卡片整体让位一格（等价于把 active 移到
 * over 的下标，即 arrayMove(activeIdx → overIdx)），松手后的最终顺序必须等于用户
 * 看到的预览顺序。实现即「把 active 从列内取出，再按 over 的下标插回」：
 *  - 原在 over 上方（含跨列而来）→ 插到 over **之前**（over 及其后让位）；
 *  - 原在 over 下方 → 插到 over **之后**（over 让位，落到它的槽位）。
 *
 * @param columnCards 目标列卡片，按 position 升序
 * @param activeCardId 被拖卡片 id
 * @param overCardId 落点卡片 id
 * @returns 目标 position；`null` = 落点与当前位置等价（无需提交移动）
 */
export function computeDropPosition(
  columnCards: KanbanCard[],
  activeCardId: string,
  overCardId: string,
): number | null {
  if (activeCardId === overCardId) return null
  const overIdx = columnCards.findIndex((c) => c.id === overCardId)
  const overCard = columnCards[overIdx]
  if (!overCard) return null
  const activeIdx = columnCards.findIndex((c) => c.id === activeCardId)

  // 取出 active 后的列内顺序 + 目标插入下标（over 在该顺序中的位置，
  // 原在 over 下方时插到其后）。
  const others = columnCards.filter((c) => c.id !== activeCardId)
  const overIdxInOthers = others.findIndex((c) => c.id === overCardId)
  if (overIdxInOthers === -1) return null
  const insertIdx = activeIdx !== -1 && activeIdx < overIdx ? overIdxInOthers + 1 : overIdxInOthers

  // 落点与当前位置等价：把 active 插回 others 的 insertIdx 即还原原顺序
  // ⇔ insertIdx === active 在原数组中的下标（跨列而来时恒为真实移动）。
  if (activeIdx !== -1 && insertIdx === activeIdx) return null

  const prev = others[insertIdx - 1]
  const next = others[insertIdx]
  if (prev && next) return (prev.position + next.position) / 2
  if (prev) return prev.position + POSITION_GAP
  if (next) return next.position - POSITION_GAP / 2
  return POSITION_GAP // 目标列仅有 over 一张卡且 active 已取出：任意正值
}

export { POSITION_GAP }
