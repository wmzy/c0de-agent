/**
 * KanbanColumn 拖拽激活回归测试。
 *
 * 缺陷：DraggableCard 先 `{...listeners}` 再写 `onPointerDown={e => e.stopPropagation()}`，
 * 后者覆盖 dnd-kit 的 PointerSensor 激活器，拖拽永不启动（卡片 transform 恒为空）。
 * 断言必须在 pointerdown 后检查 dnd-kit 确实收到激活事件——这正是坏掉的接线点，
 * 只断言卡片渲染通过无法捕获该回归。
 */
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KanbanColumn } from '@/components/kanban/KanbanColumn.js'
import type { KanbanCard, KanbanColumnDef } from '@/services/kanban.js'

/** 记录 DndContext 收到的 dragstart，用它判断传感器是否被真正激活。 */
const dragStartSpy = vi.fn()
const dragEndSpy = vi.fn()

function column(id: string, name: string): KanbanColumnDef {
  return { id, name }
}

function card(id: string, title: string, columnId: string): KanbanCard {
  return {
    id,
    boardId: 'board',
    title,
    description: null,
    columnId,
    priority: 'medium',
    position: 1000,
    labels: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** 与 KanbanView 相同的传感器配置：PointerSensor + 5px 启动距离。 */
function Harness({ children }: { children: React.ReactNode }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  return (
    <DndContext sensors={sensors} onDragStart={dragStartSpy} onDragEnd={dragEndSpy}>
      {children}
    </DndContext>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('KanbanColumn 拖拽', () => {
  it('指针按下并移动后应触发 dragstart（激活器未被 onPointerDown 覆盖）', () => {
    render(
      <Harness>
        <KanbanColumn
          column={column('todo', '待办')}
          cards={[card('c1', '第一张卡', 'todo')]}
          labels={[]}
          onCardClick={vi.fn()}
          onQuickAdd={vi.fn()}
        />
      </Harness>,
    )

    const el = screen.getByTestId('kanban-card-c1')
    // isPrimary 必须显式为 true：dnd-kit 的 PointerSensor 激活器
    // 见到非主指针会直接拒绝（happy-dom 的 pointerdown 默认 isPrimary=false）。
    fireEvent.pointerDown(el, { bubbles: true, cancelable: true, isPrimary: true, button: 0 })
    fireEvent.pointerMove(document, { bubbles: true, clientX: 40, clientY: 40, isPrimary: true })

    expect(dragStartSpy).toHaveBeenCalled()
  })
})
