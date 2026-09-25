import { describe, expect, it } from 'vitest'
import { computeDropPosition } from '@/components/kanban/drop-position.js'
import type { KanbanCard } from '@/services/kanban.js'

/** 构造列内卡片（position 递增，与后端 POSITION_GAP=1000 同口径）。 */
function card(id: string, position: number, columnId = 'todo'): KanbanCard {
  return {
    id,
    boardId: 'board',
    title: id,
    description: null,
    columnId,
    priority: 'medium',
    position,
    labels: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** dnd-kit 语义：把 active 移到 over 的下标（移除后再插入）。 */
function arrayMove<T>(items: T[], from: number, to: number): T[] {
  const next = [...items]
  const [moved] = next.splice(from, 1)
  if (moved !== undefined) next.splice(to, 0, moved)
  return next
}

/** 模拟服务端：把算出的 position 写回卡片，再按 position 升序取列内顺序。 */
function orderAfterDrop(
  cards: KanbanCard[],
  activeId: string,
  overId: string,
  targetColumnId = 'todo',
): string[] {
  // computeDropPosition 的契约是「目标列卡片（position 升序）」
  const columnCards = cards
    .filter((c) => c.columnId === targetColumnId)
    .sort((a, b) => a.position - b.position)
  const position = computeDropPosition(columnCards, activeId, overId)
  const moved = cards.map((c) =>
    c.id === activeId ? { ...c, columnId: targetColumnId, position: position ?? c.position } : c,
  )
  return moved
    .filter((c) => c.columnId === targetColumnId)
    .sort((a, b) => a.position - b.position)
    .map((c) => c.id)
}

describe('computeDropPosition', () => {
  const abc = [card('A', 1000), card('B', 2000), card('C', 3000)]

  it('拖到紧邻下方卡片：落到其槽位（预览里该卡片上移让位）', () => {
    // dnd-kit 预览：A 被画在 B 的槽位、B 上移 → 期望 [B, A, C]。
    // 此前实现判为「前驱就是自己 → 无位移」直接跳过，拖拽无任何效果。
    expect(orderAfterDrop(abc, 'A', 'B')).toEqual(['B', 'A', 'C'])
  })

  it('拖到下方隔一张卡片：落到其槽位（插到目标之后）', () => {
    // 预览：A 画在 C 的槽位、B 与 C 各上移一格 → 期望 [B, C, A]。
    // 此前实现取「前一张与目标的中点」→ 落到 B 与 C 之间 → [B, A, C]，与预览差一格。
    expect(orderAfterDrop(abc, 'A', 'C')).toEqual(['B', 'C', 'A'])
  })

  it('拖到紧邻上方卡片：落到其槽位（该卡片下移让位）', () => {
    // 预览：C 画在 B 的槽位、B 下移 → 期望 [A, C, B]。
    // 此前实现取「目标与后一张的中点」→ 落到 B 之后 → [A, B, C]，等于没动。
    expect(orderAfterDrop(abc, 'C', 'B')).toEqual(['A', 'C', 'B'])
  })

  it('拖到上方隔一张卡片：落到其槽位（插到目标之前）', () => {
    // 预览：C 画在 A 的槽位、A 与 B 各下移一格 → 期望 [C, A, B]。
    // 此前实现落到 A 与 B 之间 → [A, C, B]，与预览差一格。
    expect(orderAfterDrop(abc, 'C', 'A')).toEqual(['C', 'A', 'B'])
  })

  it('同列任意 (active, over) 组合的落位等于 arrayMove 语义', () => {
    const ids = abc.map((c) => c.id)
    for (let from = 0; from < ids.length; from++) {
      for (let to = 0; to < ids.length; to++) {
        if (from === to) continue
        const activeId = ids[from] as string
        const overId = ids[to] as string
        expect(orderAfterDrop(abc, activeId, overId), `${activeId}→${overId}`).toEqual(
          arrayMove(ids, from, to),
        )
      }
    }
  })

  it('跨列落到卡片上：插到该卡片之前（该卡片及其后卡片让位）', () => {
    const target = [card('X', 1000, 'doing'), card('Y', 2000, 'doing'), card('Z', 3000, 'doing')]
    const board = [...abc, ...target]
    // active 不在目标列（activeIdx === -1）→ 落在 over 的槽位 = over 之前
    expect(orderAfterDrop(board, 'A', 'Y', 'doing')).toEqual(['X', 'A', 'Y', 'Z'])
    expect(orderAfterDrop(board, 'A', 'Z', 'doing')).toEqual(['X', 'Y', 'A', 'Z'])
  })

  it('落到自身：无位移（返回 null）', () => {
    expect(computeDropPosition(abc, 'B', 'B')).toBeNull()
  })

  it('position 落在相邻两张卡片之间（中点或列首/列尾半距）', () => {
    const aToB = computeDropPosition(abc, 'A', 'B')
    expect(aToB).toBeGreaterThan(2000) // B 之后
    expect(aToB).toBeLessThan(3000) // C 之前
    const cToA = computeDropPosition(abc, 'C', 'A')
    expect(cToA).toBeLessThan(1000) // A 之前
  })
})
