// 工具视图渲染「未收敛的外部形状」的回归用例。
//
// 缺陷：tool_result.metadata 与 tool_call.input 都是原样落库的 JSON（持久层只过滤
// _parseError/_raw，导入层只校验分片外形、不递归 metadata）。Todo/Kanban 视图
// 此前 `as TodoPhase[]` / `as KanbanBoard` 之后直接 `.filter` / `.map`，Task 视图
// 直接 `inp.prompt.slice()` 与 `<pre>{inp.context}</pre>`：一条畸形条目就在渲染期
// 抛错，而 ErrorBoundary 裹的是整个应用壳——顶栏、侧栏、会话页一起被换成
// 「页面渲染出错」，这条会话再也无法展开该工具块。修复口径是渲染前收敛
// （toolShape.tsx）：畸形条目丢弃并计数，且必须说出来，绝不把「读不出来」
// 渲染成「待办为空 / 看板为空」。

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { KanbanToolView } from '@/components/session/tools/KanbanToolView.js'
import { TaskToolView } from '@/components/session/tools/TaskToolView.js'
import { TodoToolView } from '@/components/session/tools/TodoToolView.js'

afterEach(cleanup)

describe('TodoToolView 畸形 metadata', () => {
  it('tasks 不是数组时渲染其余阶段，并说明有几项读不出来', () => {
    render(
      <TodoToolView
        input={{ op: 'view' }}
        status="completed"
        output={{
          _tag: 'success',
          output: '',
          metadata: {
            phases: [
              { name: '阶段一', tasks: [{ content: '写文档', status: 'pending' }] },
              { name: 1, tasks: 'garbage' },
            ],
          },
        }}
      />,
    )
    expect(screen.getByText('写文档')).toBeInTheDocument()
    expect(screen.getByTestId('tool-shape-notice')).toHaveTextContent('1 项内容格式异常')
  })

  it('全部条目畸形时说「读不出来」，不说「待办为空」', () => {
    render(
      <TodoToolView
        input={{ op: 'view' }}
        status="completed"
        output={{
          _tag: 'success',
          output: '',
          metadata: { phases: [{ name: 1, tasks: 'garbage' }] },
        }}
      />,
    )
    expect(screen.queryByText(/Todo list is empty/i)).toBeNull()
    expect(screen.getByTestId('tool-shape-notice')).toBeInTheDocument()
  })

  it('phases 整体不是数组时同样不谎报为空', () => {
    render(
      <TodoToolView
        input={{ op: 'view' }}
        status="completed"
        output={{ _tag: 'success', output: '', metadata: { phases: 'garbage' } }}
      />,
    )
    expect(screen.queryByText(/Todo list is empty/i)).toBeNull()
    expect(screen.getByTestId('tool-shape-notice')).toHaveTextContent('无法解析')
  })
})

describe('KanbanToolView 畸形 metadata', () => {
  it('卡片 title 不是字符串时丢弃该卡，其余照常渲染并计数', () => {
    render(
      <KanbanToolView
        input={{ op: 'view' }}
        status="completed"
        output={{
          _tag: 'success',
          output: '',
          metadata: {
            board: {
              columns: [{ id: 'c1', name: '待办' }],
              cards: [
                { id: 'a', title: '正常卡片', columnId: 'c1', priority: 'high' },
                { id: 'b', title: { nested: true }, columnId: 'c1' },
              ],
            },
          },
        }}
      />,
    )
    expect(screen.getByText('正常卡片')).toBeInTheDocument()
    expect(screen.queryByText(/看板为空/)).toBeNull()
    expect(screen.getByTestId('tool-shape-notice')).toHaveTextContent('1 项内容格式异常')
  })

  it('board 不是对象时不谎报「看板为空」', () => {
    render(
      <KanbanToolView
        input={{ op: 'view' }}
        status="completed"
        output={{ _tag: 'success', output: '', metadata: { board: 'garbage' } }}
      />,
    )
    expect(screen.queryByText(/看板为空/)).toBeNull()
    expect(screen.getByTestId('tool-shape-notice')).toBeInTheDocument()
  })

  it('成功结果里压根没有 board（add/move）时仍不画空看板', () => {
    render(
      <KanbanToolView
        input={{ op: 'add', title: '新卡' }}
        status="completed"
        output={{ _tag: 'success', output: 'ok' }}
      />,
    )
    expect(screen.queryByText(/看板为空/)).toBeNull()
    expect(screen.queryByTestId('tool-shape-notice')).toBeNull()
  })
})

describe('TaskToolView 畸形 input', () => {
  it('prompt 是对象时不崩溃，且不画出无法命名的节点', () => {
    render(
      <TaskToolView
        input={{ subagent_type: 'coder', prompt: { steps: ['a', 'b'] } }}
        status="error"
        output={{ _tag: 'error', error: 'prompt 必须是字符串' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('prompt 必须是字符串')
    expect(screen.getByTestId('task-tool-view')).toBeInTheDocument()
  })

  it('批量任务的 description 是对象时不崩溃，落回可读的默认名', () => {
    render(
      <TaskToolView
        input={{
          subagent_type: 'coder',
          tasks: [{ description: { nested: true } }, { description: '正常任务' }],
        }}
        status="completed"
        output={{ _tag: 'success', output: 'done' }}
      />,
    )
    expect(screen.getByText('Task 1')).toBeInTheDocument()
    expect(screen.getByText('正常任务')).toBeInTheDocument()
    expect(screen.getByTestId('task-output')).toHaveTextContent('done')
  })

  it('context 是对象时不渲染 Shared Context 段', () => {
    render(
      <TaskToolView
        input={{ context: { goal: '重构' }, description: '干这个', prompt: 'go' }}
        status="completed"
        output={{ _tag: 'success', output: 'ok' }}
      />,
    )
    expect(screen.queryByText('Shared Context')).toBeNull()
    expect(screen.getByTestId('task-tool-view')).toBeInTheDocument()
  })

  it('metadata.subtasks 形状漂移时不产生状态未知的节点', () => {
    render(
      <TaskToolView
        input={{ tasks: [{ description: 'A' }, { description: 'B' }] }}
        status="completed"
        output={{
          _tag: 'success',
          output: 'ok',
          metadata: {
            subtasks: [
              { index: '0', status: 'done' },
              { index: 1, status: 'failed' },
            ],
          },
        }}
      />,
    )
    expect(screen.getByTestId('task-tool-view')).toBeInTheDocument()
  })
})
