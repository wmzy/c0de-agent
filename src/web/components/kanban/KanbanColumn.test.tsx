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
  it('指针按下并移动后应触发 dragstart（激活器未被 onPointerDown 覆盖）', async () => {
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

    // 收尾松开指针：dnd-kit 的 PointerSensor 激活后在 document 上挂一个捕获阶段的
    // click 抑制监听（压制拖拽结束那次合成 click），要等 dragend 才摘掉。不松开则
    // 传感器一直处于激活态，该监听跨用例存活，把后续用例里的 click 一并吞掉
    // （同文件的快速新建用例点「+ 新建卡片」时输入框不出现）。
    fireEvent.pointerUp(document, { isPrimary: true, button: 0 })
    expect(dragEndSpy).toHaveBeenCalled()

    // 传感器 detach 时摘监听是 `setTimeout(removeAll, 50)`（AbstractPointerSensor.detach），
    // 让开这一拍，否则捕获阶段的 click 抑制器活到下一个用例，把那里第一次 click 吃掉
    // （下面「快速新建」用例点「+ 新建卡片」不展开）。
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
})

describe('KanbanColumn 快速新建的焦点', () => {
  // 回归：点「+ 新建卡片」后输入框出现，但焦点留在 body。用户必须再点一次输入框
  // 才能打字——直接敲键全部落空（既没进输入框、也没有任何提示）；键盘用户按
  // Enter 展开后，下一次 Tab 会从页面开头重走一遍才能回到刚打开的输入框。
  it('展开快速新建后焦点落在标题输入框，可直接键入', () => {
    render(
      <Harness>
        <KanbanColumn
          column={column('todo', '待办')}
          cards={[]}
          labels={[]}
          onCardClick={vi.fn()}
          onQuickAdd={vi.fn()}
        />
      </Harness>,
    )

    fireEvent.click(screen.getByText('+ 新建卡片'))
    const input = screen.getByPlaceholderText('卡片标题…')
    expect(document.activeElement).toBe(input)
  })

  // 回调 ref 若用内联箭头，身份每轮渲染都变，React 会重新调用它（先 null 再元素），
  // 焦点被反复抢回输入框——「添加中…」期间想点「添加」会被拽回来。
  it('重渲染不抢走已移开的焦点', () => {
    const onQuickAdd = vi.fn(() => new Promise<void>(() => {}))
    const { rerender } = render(
      <Harness>
        <KanbanColumn
          column={column('todo', '待办')}
          cards={[]}
          labels={[]}
          onCardClick={vi.fn()}
          onQuickAdd={onQuickAdd}
        />
      </Harness>,
    )

    fireEvent.click(screen.getByText('+ 新建卡片'))
    const add = screen.getByText('添加')
    add.focus()
    expect(document.activeElement).toBe(add)

    // 父级重渲染（同 props 重挂一次）后焦点应仍在「添加」
    rerender(
      <Harness>
        <KanbanColumn
          column={column('todo', '待办')}
          cards={[]}
          labels={[]}
          onCardClick={vi.fn()}
          onQuickAdd={onQuickAdd}
        />
      </Harness>,
    )
    expect(document.activeElement).toBe(screen.getByText('添加'))
  })
})
