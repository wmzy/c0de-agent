// 工具失败结果的渲染回归：失败必须显示真实原因，不能塌成「空」。
//
// 缺陷：Todo/Kanban 视图此前没有失败分支，_tag==='error' 落到空渲染，
// 一次失败的 todo 调用显示为 "Todo list is empty."，一次失败的 kanban move
// 只剩一行 op 名——两者都会让用户得出与真实原因相反的结论。

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BashToolView } from '@/components/session/tools/BashToolView.js'
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

  // 回归：todo 执行器刻意让操作级失败仍返回 _tag:'success'（不污染工具指标、
  // 让模型读得见原因好重试），失败原因以 `Errors: …` 行随 output 返回，且整批
  // 改动被丢弃（metadata.phases 回到执行前）。视图此前只读 metadata、从不渲染
  // output 文本，于是这次失败被渲染成一个 ✓ 完成的折叠行：用户看到
  // 「todo · done ✓」与原封不动的任务列表，无从分辨操作到底有没有生效。
  it('成功结果里内嵌的 Errors 行必须透出，而不是显示成一次成功的 done', () => {
    render(
      <TodoToolView
        input={{ op: 'done', task: '不存在的任务' }}
        status="completed"
        output={{
          _tag: 'success',
          output: 'Errors: Task "不存在的任务" not found.\nRemaining: 1.',
          metadata: {
            phases: [{ name: '阶段一', tasks: [{ content: '写文档', status: 'pending' }] }],
          },
        }}
      />,
    )
    expect(screen.getByTestId('tool-inline-error')).toHaveTextContent('not found')
    // 列表仍按执行后的真实状态渲染（这里没生效），但原因不再被吞
    expect(screen.getByText('写文档')).toBeInTheDocument()
  })

  // 回归：running 态（tool_result 还没到）此前落进 Board 的空渲染——折叠头是
  // 「⏳ 执行中」，展开正文却写着 "Todo list is empty."，agent 每跑一次 todo 都是
  // 这个画面。用户据「待办为空」重新规划/重新下发任务，结果回来后列表又被真实阶段
  // 替换回。「没有结果」与「结果说没有」必须分开（同 KanbanToolView 在 board=null
  // 时不画的口径）。
  it('执行中（结果未到达）时不谎报待办为空', () => {
    render(<TodoToolView input={{ op: 'view' }} status="running" output={undefined} />)
    expect(screen.queryByText(/Todo list is empty/i)).toBeNull()
    expect(screen.getByTestId('todo-running')).toHaveTextContent('执行中')
  })
})

// 「输出被截断」（_tag:'truncated'）此前也落在空态上：executor 对超上限的成功结果
// 返回 truncated 且丢掉 metadata（src/tools/executor.ts），而这两个视图只在 success
// 分支读 metadata——待办被说成 "Todo list is empty."、看板整块塌成一行 op 名，把
// 「内容太大没随结果返回」讲成「什么都没有」。
describe('Todo/Kanban 截断结果', () => {
  it('todo 截断时说明截断并渲染文本，而不是显示待办为空', () => {
    render(
      <TodoToolView
        input={{ op: 'view' }}
        status="completed"
        output={{
          _tag: 'truncated',
          output: 'Remaining items (1):\n  - 1-1: 写文档 [pending] (阶段一)',
          truncated: true,
          totalLines: 4210,
        }}
      />,
    )
    expect(screen.queryByText(/Todo list is empty/i)).toBeNull()
    expect(screen.getByTestId('tool-truncated')).toHaveTextContent('4210')
    expect(screen.getByTestId('tool-truncated-text')).toHaveTextContent('写文档')
  })

  it('kanban 截断时说明截断并渲染文本，而不是只剩 op 名', () => {
    render(
      <KanbanToolView
        input={{ op: 'view' }}
        status="completed"
        output={{
          _tag: 'truncated',
          output: '## 待办 (2)\n  🔴 [card-1] 修 bug\n  ⚪ [card-2] 写文档',
          truncated: true,
          totalLines: 3890,
        }}
      />,
    )
    expect(screen.getByTestId('tool-truncated')).toHaveTextContent('3890')
    expect(screen.getByTestId('tool-truncated-text')).toHaveTextContent('修 bug')
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

  // 同 todo：kanban 执行器也把操作级失败写成 success + output 首行 `Errors: …`。
  // 视图此前只读 metadata.board，于是「移动到不存在的列」渲染成一个 ✓ 完成的
  // 行 + 一句「移动到: col-9」意图 + 原封不动的看板，看起来像移动成功了。
  it('成功结果里内嵌的 Errors 行必须透出，而不是显示成一次成功的 move', () => {
    render(
      <KanbanToolView
        input={{ op: 'move', id: 'card-1', columnId: 'col-9' }}
        status="completed"
        output={{
          _tag: 'success',
          output: 'Errors: column col-9 does not exist\n\n## 待办 (1)\nTotal: 1 card(s).',
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
    expect(screen.getByTestId('tool-inline-error')).toHaveTextContent('column col-9 does not exist')
  })

  // 回归：卡片引用的列已被删掉（历史脏数据）时，此前只按现有列过滤 → 这些卡片
  // 一条都不画；全是幽灵卡时 <div className={boardStyle}> 里没有任何子节点——
  // 连列头都没有的空白看板，用户会认定卡片被谁删了。执行器早已在 output 文本里
  // 为模型列出「## 未归属列 (N)」（src/tools/builtin/kanban.ts），视图必须说同一件事。
  it('引用已删除列的卡片必须渲染，而不是变成一块空白看板', () => {
    render(
      <KanbanToolView
        input={{ op: 'view' }}
        status="completed"
        output={{
          _tag: 'success',
          output: '## 未归属列 (1)\n  [ghost-1] "修 bug"\nTotal: 1 card(s).',
          metadata: {
            board: {
              columns: [{ id: 'todo', name: '待办' }],
              cards: [
                {
                  id: 'ghost-1',
                  title: '修 bug',
                  columnId: 'col-deleted',
                  priority: 'high',
                  description: null,
                },
              ],
            },
          },
        }}
      />,
    )
    // 列头文本被拆进多个节点，用规范化匹配
    expect(screen.getByText((_, el) => el?.textContent === '未归属列 (1)')).toBeInTheDocument()
    expect(screen.getByText('修 bug')).toBeInTheDocument()
    // 有卡片（哪怕全是幽灵卡）就不能说「看板为空」
    expect(screen.queryByText('看板为空')).toBeNull()
  })

  it('正常列与未归属列同时渲染', () => {
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
                { id: 'c1', title: '写文档', columnId: 'todo', priority: 'low', description: null },
                {
                  id: 'ghost-1',
                  title: '修 bug',
                  columnId: 'col-gone',
                  priority: 'high',
                  description: null,
                },
              ],
            },
          },
        }}
      />,
    )
    expect(screen.getByText((_, el) => el?.textContent === '待办 (1)')).toBeInTheDocument()
    expect(screen.getByText('写文档')).toBeInTheDocument()
    expect(screen.getByText((_, el) => el?.textContent === '未归属列 (1)')).toBeInTheDocument()
    expect(screen.getByText('修 bug')).toBeInTheDocument()
  })

  it('没有内嵌 Errors 行的正常成功结果不渲染失败块', () => {
    render(
      <KanbanToolView
        input={{ op: 'view' }}
        status="completed"
        output={{
          _tag: 'success',
          output: '## 待办 (0)\nTotal: 0 card(s).',
          metadata: { board: { columns: [], cards: [] } },
        }}
      />,
    )
    expect(screen.queryByTestId('tool-inline-error')).toBeNull()
    expect(screen.queryByTestId('tool-error')).toBeNull()
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

// BashToolView 是全仓唯一没接 toolError 的工具视图：它把 _tag==='error' 的
// output.error 塞进渲染成功 stdout 的那个中性灰 <pre data-testid="bash-output">。
// 于是 `Command failed with exit code: 127` / `Command timeout after 30000ms` /
// `Failed to spawn command: …` 与命令的正常输出完全同形，用户读不出这是失败原因；
// error 为空白串时 outText===''，整块一个字都不渲染，ToolBlock 只剩一个 ✗ 字形。
describe('BashToolView 失败结果', () => {
  it('失败透出原因，不再与成功 stdout 同形', () => {
    render(
      <BashToolView
        input={{ command: 'bad' }}
        status="error"
        output={{ _tag: 'error', error: 'Command failed with exit code: 127\nboom' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('127')
    expect(screen.getByTestId('tool-error')).toHaveTextContent('boom')
    // 关键判据：失败不再落进 `bash-output`——修前这条断言取到的是灰 <pre>，与成功无差。
    expect(screen.queryByTestId('bash-output')).toBeNull()
    // 命令块保留，用户要看清是哪个命令挂了。
    expect(screen.getByTestId('bash-command')).toBeInTheDocument()
  })

  it('error 为空串时仍给出占位说明，而不是整块空白', () => {
    render(
      <BashToolView
        input={{ command: 'bad' }}
        status="error"
        output={{ _tag: 'error', error: '' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent(/没有返回错误信息/)
    expect(screen.queryByTestId('bash-output')).toBeNull()
  })

  it('status=error 但 output 缺失时不再静默渲染为空', () => {
    render(<BashToolView input={{ command: 'bad' }} status="error" />)
    expect(screen.getByTestId('tool-error')).toHaveTextContent(/没有返回错误信息/)
    expect(screen.queryByTestId('bash-output')).toBeNull()
  })

  it('成功仍走 bash-output，不渲染失败块', () => {
    render(
      <BashToolView
        input={{ command: 'echo hi' }}
        status="completed"
        output={{ _tag: 'success', output: 'hi', metadata: { exitCode: 0 } }}
      />,
    )
    expect(screen.getByTestId('bash-output')).toHaveTextContent('hi')
    expect(screen.getByTestId('bash-exit')).toHaveTextContent('0')
    expect(screen.queryByTestId('tool-error')).toBeNull()
  })
})
