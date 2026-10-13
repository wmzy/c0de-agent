// 工具失败结果的渲染回归：失败必须显示真实原因，不能塌成「空」。
//
// 缺陷：Todo/Kanban 视图此前没有失败分支，_tag==='error' 落到空渲染，
// 一次失败的 todo 调用显示为 "Todo list is empty."，一次失败的 kanban move
// 只剩一行 op 名——两者都会让用户得出与真实原因相反的结论。

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FallbackToolView } from '@/components/session/tools/FallbackToolView.js'
import { GlobToolView } from '@/components/session/tools/GlobToolView.js'
import { GrepToolView } from '@/components/session/tools/GrepToolView.js'
import { KanbanToolView } from '@/components/session/tools/KanbanToolView.js'
import { TaskToolView } from '@/components/session/tools/TaskToolView.js'
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

describe('TaskToolView 批量子 agent 状态', () => {
  const batchInput = {
    subagent_type: 'reviewer',
    context: '审查三个文件',
    tasks: [
      { description: '审查 a.ts', assignment: '看 a' },
      { description: '审查 b.ts', assignment: '看 b' },
      { description: '审查 c.ts', assignment: '看 c' },
    ],
  }

  // 缺陷：节点状态取父工具状态，批量里失败一个，成功的那几个也被画成「失败」——
  // 与同一块里「Completed: …」的文本自相矛盾（实测 2 成 1 败，图上 3 个全红）。
  it('部分失败时逐节点显示真实状态', () => {
    render(
      <TaskToolView
        input={batchInput}
        status="error"
        output={{
          _tag: 'error',
          error: 'Sub-agent failed: [task] boom',
          metadata: {
            subtasks: [
              { index: 0, status: 'completed' },
              { index: 1, status: 'completed' },
              { index: 2, status: 'failed' },
            ],
          },
        }}
      />,
    )
    // 用户可见的结论：3 个子任务里 2 个完成、只有 c 失败（此前 3 个全红）。
    expect(screen.getAllByText(/· 已完成/)).toHaveLength(2)
    expect(screen.getAllByText(/· 失败/)).toHaveLength(1)
    // 失败的那个必须挂在正确的节点上（c.ts），不能错位。
    expect(screen.getByTestId('workflow-graph').textContent).toContain('审查 c.ts✗ reviewer · 失败')
    expect(screen.getByTestId('workflow-graph').textContent).toContain(
      '审查 a.ts✓ reviewer · 已完成',
    )
  })

  it('缺 metadata（旧历史消息）时回落到父工具状态', () => {
    render(<TaskToolView input={batchInput} status="running" output={undefined} />)
    expect(screen.getAllByText(/· 执行中/)).toHaveLength(3)
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

// Grep/Glob/Fallback/Task 此前各自手写失败分支，把错误文本塞进与成功输出同形的
// 中性灰 <pre>（失败与命中视觉同形），且 error 为空白串时整块渲染成空白。
describe('Grep/Glob/Fallback/Task 失败结果', () => {
  it('GrepToolView 失败透出原因，不再渲染成命中样式', () => {
    render(
      <GrepToolView
        input={{ pattern: 'foo' }}
        status="error"
        output={{ _tag: 'error', error: 'ripgrep not found' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('ripgrep not found')
    expect(screen.queryByTestId('tool-output')).toBeNull()
  })

  it('GrepToolView 成功仍渲染输出', () => {
    render(
      <GrepToolView
        input={{ pattern: 'foo' }}
        status="completed"
        output={{ _tag: 'success', output: 'a.ts:1:foo' }}
      />,
    )
    expect(screen.queryByTestId('tool-error')).toBeNull()
    expect(screen.getByTestId('tool-output')).toHaveTextContent('a.ts:1:foo')
  })

  it('GlobToolView 失败透出原因，空白 error 也给占位说明', () => {
    render(
      <GlobToolView
        input={{ pattern: '*.ts' }}
        status="error"
        output={{ _tag: 'error', error: '   ' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent(/没有返回错误信息/)
    expect(screen.queryByTestId('tool-output')).toBeNull()
  })

  it('FallbackToolView 失败透出原因，参数区仍保留', () => {
    render(
      <FallbackToolView
        tool="custom"
        input={{ real: 1 }}
        status="error"
        output={{ _tag: 'error', error: 'unsupported tool' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('unsupported tool')
    expect(screen.getByTestId('fallback-args')).toHaveTextContent('real')
    expect(screen.queryByTestId('fallback-output')).toBeNull()
  })

  it('TaskToolView 失败且 error 为空时不再只剩一张图', () => {
    render(
      <TaskToolView
        input={{ prompt: 'do something', description: '子任务' }}
        status="error"
        output={{ _tag: 'error', error: '' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent(/没有返回错误信息/)
    expect(screen.queryByTestId('task-output')).toBeNull()
  })
})
