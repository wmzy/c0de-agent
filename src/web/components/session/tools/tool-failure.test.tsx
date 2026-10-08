// 工具失败结果的渲染回归：失败必须显示真实原因，不能塌成「空」。
//
// 缺陷：Todo/Kanban 视图此前没有失败分支，_tag==='error' 落到空渲染，
// 一次失败的 todo 调用显示为 "Todo list is empty."，一次失败的 kanban move
// 只剩一行 op 名——两者都会让用户得出与真实原因相反的结论。

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { KanbanToolView } from '@/components/session/tools/KanbanToolView.js'
import { TodoToolView } from '@/components/session/tools/TodoToolView.js'

afterEach(cleanup)

describe('TodoToolView 失败结果', () => {
  it('透出失败原因，而不是显示待办为空', () => {
    render(
      <TodoToolView
        input={{ op: 'view' }}
        status="error"
        output={{ _tag: 'error', error: 'todo store unavailable' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('todo store unavailable')
    expect(screen.queryByText(/Todo list is empty/i)).toBeNull()
  })

  it('成功但无任务时才显示空态', () => {
    render(
      <TodoToolView
        input={{ op: 'view' }}
        status="completed"
        output={{ _tag: 'success', output: '', metadata: { phases: [] } }}
      />,
    )
    expect(screen.queryByTestId('tool-error')).toBeNull()
    expect(screen.getByText(/Todo list is empty/i)).toBeInTheDocument()
  })
})

describe('KanbanToolView 失败结果', () => {
  it('move 失败时透出原因，且不渲染看板', () => {
    render(
      <KanbanToolView
        input={{ op: 'move', id: 'card-1', columnId: 'col-9' }}
        status="error"
        output={{ _tag: 'error', error: 'column col-9 does not exist' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('column col-9 does not exist')
    // 失败时没有 board metadata：不得渲染任何列头
    expect(screen.queryByText((_, el) => el?.textContent === '待办 (1)')).toBeNull()
  })

  it('成功时仍渲染看板列头（与失败分支区分）', () => {
    render(
      <KanbanToolView
        input={{ op: 'view' }}
        status="completed"
        output={{
          _tag: 'success',
          output: '',
          metadata: {
            board: {
              columns: [{ id: 'todo', name: '待办' }],
              cards: [
                {
                  id: 'card-1',
                  title: '写文档',
                  columnId: 'todo',
                  priority: 'high',
                  description: null,
                },
              ],
            },
          },
        }}
      />,
    )
    expect(screen.queryByTestId('tool-error')).toBeNull()
    // 列头文本被拆进 {col.name} 与 (n) 两个节点，用规范化匹配
    expect(screen.getByText((_, el) => el?.textContent === '待办 (1)')).toBeInTheDocument()
    expect(screen.getByText('写文档')).toBeInTheDocument()
  })

  it('add 失败时透出原因', () => {
    render(
      <KanbanToolView
        input={{ op: 'add', title: '新卡' }}
        status="error"
        output={{ _tag: 'error', error: 'board locked' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('board locked')
  })
})

describe('失败结果无文案兜底', () => {
  it('error 为空串时仍给出占位说明，不渲染空白', () => {
    render(
      <TodoToolView
        input={{ op: 'view' }}
        status="error"
        output={{ _tag: 'error', error: '   ' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent(/没有返回错误信息/)
  })

  it('status=error 但 output 缺失时不再静默渲染为空', () => {
    render(<TodoToolView input={{ op: 'view' }} status="error" />)
    expect(screen.getByTestId('tool-error')).toHaveTextContent(/没有返回错误信息/)
    expect(screen.queryByText(/Todo list is empty/i)).toBeNull()
  })

  it('status=error 但 output 缺失时看板也给出说明而非空行', () => {
    render(<KanbanToolView input={{ op: 'move' }} status="error" />)
    expect(screen.getByTestId('tool-error')).toBeInTheDocument()
  })

  it('运行中（status=running）不误报失败', () => {
    render(<TodoToolView input={{ op: 'view' }} status="running" />)
    expect(screen.queryByTestId('tool-error')).toBeNull()
  })
})
