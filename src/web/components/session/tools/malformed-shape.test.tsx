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
import { BashToolView } from '@/components/session/tools/BashToolView.js'
import { EditToolView } from '@/components/session/tools/EditToolView.js'
import { KanbanToolView } from '@/components/session/tools/KanbanToolView.js'
import { ReadToolView } from '@/components/session/tools/ReadToolView.js'
import { TaskToolView } from '@/components/session/tools/TaskToolView.js'
import { TodoToolView } from '@/components/session/tools/TodoToolView.js'
import { WriteToolView } from '@/components/session/tools/WriteToolView.js'

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

describe('工具视图畸形 input（op / id / hunks）', () => {
  it('todo 的 op 是对象时不崩，落回可读的默认 op', () => {
    render(
      <TodoToolView
        input={{ op: { kind: 'add' } }}
        status="completed"
        output={{ _tag: 'success', output: '', metadata: { phases: [] } }}
      />,
    )
    expect(screen.getByText('view')).toBeInTheDocument()
  })

  it('kanban 的 op 是对象、id 是数字时不崩（id 不再 .slice 出 TypeError）', () => {
    render(
      <KanbanToolView
        input={{ op: { kind: 'delete' }, id: 12345 }}
        status="completed"
        output={{ _tag: 'success', output: 'ok' }}
      />,
    )
    expect(screen.getByText('kanban/view')).toBeInTheDocument()
  })

  it('kanban 的 delete 明细只在 id 是字符串时渲染', () => {
    render(
      <KanbanToolView
        input={{ op: 'delete', id: 'abcdef123456' }}
        status="completed"
        output={{ _tag: 'success', output: 'ok' }}
      />,
    )
    expect(screen.getByText('删除: abcdef12')).toBeInTheDocument()
  })

  it('edit 的 metadata.hunks 形状漂移时不崩，退回工具结论文本', () => {
    render(
      <EditToolView
        input={{ path: 'a.ts', patch: '@@ -1,1 +1,1 @@' }}
        status="completed"
        output={{
          _tag: 'success',
          output: '已应用 1 处改动',
          metadata: { hunks: 'garbage' },
        }}
      />,
    )
    expect(screen.getByTestId('edit-hashline-output')).toHaveTextContent('已应用 1 处改动')
  })

  it('edit 的 hunks 里有畸形条目时丢弃该条，其余照常渲染 diff', () => {
    render(
      <EditToolView
        input={{ path: 'a.ts', patch: '@@ -1,1 +1,1 @@' }}
        status="completed"
        output={{
          _tag: 'success',
          output: 'ok',
          metadata: {
            hunks: [{ _tag: 'replace', start: 1, end: 1, removed: ['old'], added: ['new'] }, null],
          },
        }}
      />,
    )
    expect(screen.queryByTestId('edit-hashline-output')).toBeNull()
    expect(screen.getByText('old')).toBeInTheDocument()
    expect(screen.getByText('new')).toBeInTheDocument()
  })

  it('edit 的 input 不是对象时（模型把 arguments 写成字符串）不崩', () => {
    render(
      <EditToolView
        input={'ls' as never}
        status="completed"
        output={{ _tag: 'success', output: 'ok' }}
      />,
    )
    expect(screen.queryByTestId('tool-error')).toBeNull()
  })
})

/**
 * read/write/bash 三个视图的**入参**（此前只覆盖了 todo/kanban/task/edit 的
 * metadata 侧）。
 *
 * 缺陷：这三个视图取字段时是 `input?.command ?? ''` / `input?.path ?? ''`，没有
 * 任何 typeof 守卫，畸形入参会一路进到需要字符串的渲染点——FileCodeBlock 的
 * `extToLang(path)` 里 `filename.split('.')` 抛 TypeError、`<pre>{content}</pre>`
 * 与 CodeBlock 收到对象抛 `Objects are not valid as a React child`。两者都发生在
 * 渲染期，而 ErrorBoundary 裹的是整个应用壳（src/web/App.tsx）：顶栏、侧栏、
 * 会话页一起被换成「页面渲染出错」，这条会话再也无法展开、发不出消息。
 *
 * 实测可达：服务端 persist 只把「入参 JSON 解析失败」的调用挡在落库之外
 * （persist.ts:66），JSON 合法但形状错的调用照样连同 raw 入参写进 assistant
 * 消息并向前端发 tool_call_start；工具校验随后把它转成失败结果，而 Bash 视图的
 * 失败分支仍会渲染命令块——于是「命令跑失败」与「会话打不开」是同一次调用的两
 * 副面孔。
 */
describe('read/write/bash 畸形 input', () => {
  it('bash 的 command 是对象时退回兜底视图，原始入参摊平可见', () => {
    render(
      <BashToolView
        input={{ command: { argv: 'ls' } } as never}
        status="error"
        output={{ _tag: 'error', error: 'Command failed with exit code: 1' }}
      />,
    )
    expect(screen.getByTestId('fallback-args')).toHaveTextContent('command.argv')
    // 失败原因不能因为退回兜底就丢
    expect(screen.getByTestId('tool-error')).toHaveTextContent('exit code: 1')
  })

  it('bash 的 input 整体不是对象时不崩', () => {
    render(<BashToolView input={'ls -la' as never} status="running" />)
    expect(screen.getByTestId('fallback-args')).toHaveTextContent('ls -la')
  })

  it('write 的 content 是对象时不冒充「写入内容为空」', () => {
    render(
      <WriteToolView
        input={{ path: 'a.ts', content: { lines: ['x'] } } as never}
        status="running"
      />,
    )
    // 空 <pre> 会被读成「这次写入的内容是空的」——必须说清是原始入参读不出来
    expect(screen.getByTestId('fallback-args')).toHaveTextContent('content.lines')
  })

  it('read 的 path 是对象时退回兜底视图并保留读到的正文', () => {
    render(
      <ReadToolView
        input={{ path: { a: 1 } } as never}
        output={{ _tag: 'success', output: 'file content' }}
        status="completed"
      />,
    )
    expect(screen.getByTestId('fallback-args')).toHaveTextContent('path.a')
    expect(screen.getByTestId('fallback-output')).toHaveTextContent('file content')
  })
})
