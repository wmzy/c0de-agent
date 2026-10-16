/**
 * TodoPanel「导出到看板」语义：导出不得假定看板列配置（列 id 由用户维护，
 * 可被改名/删除或经导入替换）——目标列由看板 store 按板的首列决定。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TodoPanel } from '@/components/TodoPanel.js'
import { kanbanAPI } from '@/services/kanban.js'
import { type TodoOpResult, todoAPI } from '@/services/todo.js'

vi.mock('@/services/todo.js', () => ({
  todoAPI: { get: vi.fn(), exec: vi.fn() },
}))

vi.mock('@/services/kanban.js', () => ({
  kanbanAPI: { addCard: vi.fn() },
}))

beforeEach(() => {
  vi.mocked(todoAPI.get).mockResolvedValue({
    phases: [{ name: '阶段', tasks: [{ content: '任务A', status: 'pending' }] }],
  })
  // 模拟看板 store 的列校验：显式指定不存在的列 id 时拒绝（KanbanColumnNotFoundError）。
  // 默认看板首列是 todo，但列 id 由用户维护（BoardConfigDialog 可删除空列、导入可整板
  // 替换列配置）——「看板没有 todo 列」是完全合法的用户配置。
  vi.mocked(kanbanAPI.addCard).mockImplementation(
    async (_pid: string, input: { title: string; columnId?: string }) => {
      if (input.columnId !== undefined && input.columnId !== 'first-column') {
        throw new Error(`列 "${input.columnId}" 不存在，无法创建卡片。可用列：first-column`)
      }
      return {
        id: 'card-1',
        boardId: 'b1',
        title: input.title,
        description: null,
        columnId: input.columnId ?? 'first-column',
        priority: 'medium' as const,
        position: 1000,
        labels: [],
        createdAt: '',
        updatedAt: '',
      }
    },
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <TodoPanel sessionId="s1" projectId="p1" />
    </QueryClientProvider>,
  )
}

describe('TodoPanel 导出到看板', () => {
  it('看板没有 todo 列时导出仍成功（目标列交给看板决定）', async () => {
    renderPanel()

    // 展开面板并等待任务加载
    await waitFor(() => {
      expect(screen.getByText('任务A')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('todo-export-kanban'))

    await waitFor(() => {
      expect(screen.getByTestId('todo-export-result')).toHaveTextContent('已导出 1 个任务到看板')
    })
    expect(screen.queryByText(/导出到看板失败/)).toBeNull()
    expect(vi.mocked(kanbanAPI.addCard)).toHaveBeenCalledWith('p1', { title: '任务A' })
  })
})

/**
 * 新增任务行的两个输入框必须有可访问名称。
 *
 * 缺陷：两个框都只写 placeholder，无可见 label 也无 aria-label。placeholder
 * 不是可访问名称——读屏与语音控制只念 placeholder，且输入框一旦有值就再也不
 * 朗读，两个并排的框在无值时都只被念成同一个词。todoAPI.exec 真要往里写
 * 内容时，用户得靠猜。
 */
describe('TodoPanel 新增任务行的可访问名称', () => {
  it('「任务描述」与「阶段」两个输入框都有非空可访问名称', async () => {
    // 无任务时摘要栏点击直接打开新增行（totalTasks > 0 时它只切换折叠）
    vi.mocked(todoAPI.get).mockResolvedValue({ phases: [] })
    renderPanel()
    fireEvent.click(await screen.findByText('暂无任务，点击添加'))

    const task = await screen.findByLabelText('任务描述')
    const phase = screen.getByLabelText('阶段（可选）')
    expect(task).toBeInTheDocument()
    expect(phase).toBeInTheDocument()

    // 名称非空：空串 aria-label 等于没有名称
    for (const el of [task, phase]) {
      expect((el as HTMLElement).getAttribute('aria-label')?.trim().length ?? 0).toBeGreaterThan(0)
    }
  })
})

/**
 * 新增任务：失败时不得把用户刚打的文本清掉。
 *
 * 缺陷：handleAdd 在 mutate 落地前就 setNewTask('')/setNewPhase('')。todoAPI.exec
 * 失败时 onError 只留下一行原因，刚输入的任务描述已经从框里消失，用户只能凭
 * 记忆重打一遍——与本仓其它输入入口（新建分支、追加指令）确立的「成功后才清空」
 * 口径相反。
 */
describe('TodoPanel 新增任务失败时的输入', () => {
  it('服务端拒绝时任务文本留在输入框里，原因也可见', async () => {
    vi.mocked(todoAPI.get).mockResolvedValue({ phases: [] })
    vi.mocked(todoAPI.exec).mockRejectedValue(new Error('待办服务不可用'))
    renderPanel()
    fireEvent.click(await screen.findByText('暂无任务，点击添加'))

    const input = (await screen.findByLabelText('任务描述')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '补一条回归测试' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    expect(await screen.findByText(/待办服务不可用/)).toBeInTheDocument()
    expect((screen.getByLabelText('任务描述') as HTMLInputElement).value).toBe('补一条回归测试')
  })

  it('服务端受理后才清空输入（成功路径回归）', async () => {
    vi.mocked(todoAPI.get).mockResolvedValue({ phases: [] })
    vi.mocked(todoAPI.exec).mockResolvedValue({
      phases: [{ name: 'Tasks', tasks: [{ content: '补一条回归测试', status: 'pending' }] }],
      output: 'added',
    })
    renderPanel()
    fireEvent.click(await screen.findByText('暂无任务，点击添加'))

    const input = (await screen.findByLabelText('任务描述')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '补一条回归测试' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() => {
      expect((screen.getByLabelText('任务描述') as HTMLInputElement).value).toBe('')
    })
    expect(vi.mocked(todoAPI.exec).mock.calls[0]?.[1]).toMatchObject({
      op: 'append',
      items: ['补一条回归测试'],
    })
  })
})

/**
 * 拉不到 ≠ 没有。
 *
 * 缺陷：本面板此前只解构 useQuery 的 data。请求 500 时 data 为 undefined，
 * phases 恒为 []，与「这个会话确实没有待办」落进同一分支——摘要栏稳定显示
 * 「暂无任务，点击添加」，「导出到看板」也回「没有可导出的未完成任务」。用户
 * 据此认定 agent 维护的待办凭空消失。真实空态必须与读失败分开口。
 */
describe('TodoPanel 待办读失败态', () => {
  it('读失败时显示原因与重试入口，且不谎报「暂无任务」', async () => {
    vi.mocked(todoAPI.get).mockRejectedValue(new Error('todo 后端炸了'))
    renderPanel()

    const err = await screen.findByTestId('todo-load-error')
    expect(err).toHaveAttribute('role', 'alert')
    // 后端原因说出口，用户能判断是服务端问题还是网络问题
    expect(err.textContent).toContain('todo 后端炸了')
    // 关键：不得说成「没有任务」——那会让用户以为待办丢了
    expect(screen.queryByText('暂无任务，点击添加')).toBeNull()
    expect(screen.getByTestId('todo-retry')).toBeInTheDocument()
  })

  it('摘要栏在读失败时说「读取失败」而不是「暂无任务」，点它是重试', async () => {
    vi.mocked(todoAPI.get).mockRejectedValue(new Error('boom'))
    renderPanel()

    const bar = await screen.findByText('读取失败，点此重试')
    fireEvent.click(bar)

    await waitFor(() => {
      expect(vi.mocked(todoAPI.get).mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('读失败时「导出到看板」不谎报「没有可导出的未完成任务」', async () => {
    vi.mocked(todoAPI.get).mockRejectedValue(new Error('boom'))
    renderPanel()

    await screen.findByTestId('todo-load-error')
    fireEvent.click(screen.getByTestId('todo-export-kanban'))

    expect(await screen.findByText(/待办读取失败，无法导出/)).toBeInTheDocument()
    expect(screen.queryByText('没有可导出的未完成任务')).toBeNull()
    // 拉不到就没东西可导，一个卡片都不该发出去
    expect(kanbanAPI.addCard).not.toHaveBeenCalled()
  })

  it('真实空态仍是「暂无任务，点击添加」（与失败态区分）', async () => {
    vi.mocked(todoAPI.get).mockResolvedValue({ phases: [] })
    renderPanel()

    expect(await screen.findByText('暂无任务，点击添加')).toBeInTheDocument()
    expect(screen.queryByTestId('todo-load-error')).toBeNull()
  })
})

/**
 * 清单非空后「添加任务」入口必须仍然可达。
 *
 * 缺陷：setShowAdd(true) 唯一出现在摘要栏 onClick 的 `totalTasks === 0` 分支，
 * 而 totalTasks > 0 时该按钮只切换折叠。agent 写入第一条待办后，组件里再无
 * 任何地方能把 showAdd 置真——两个新增表单（正文内、空态下）都由它驱动，
 * 于是用户永远打不开新增行，面板只剩「导出到看板」。
 */
describe('TodoPanel 已有任务后的新增入口', () => {
  it('清单非空时点「＋ 添加任务」能打开新增行并提交', async () => {
    vi.mocked(todoAPI.get).mockResolvedValue({
      phases: [{ name: '阶段', tasks: [{ content: '任务A', status: 'pending' }] }],
    })
    vi.mocked(todoAPI.exec).mockResolvedValue({
      phases: [
        {
          name: '阶段',
          tasks: [
            { content: '任务A', status: 'pending' },
            { content: '手动补一条', status: 'pending' },
          ],
        },
      ],
      output: 'added',
    })
    renderPanel()

    await screen.findByText('任务A')
    // 打开前没有任何新增输入框
    expect(screen.queryByLabelText('任务描述')).toBeNull()

    fireEvent.click(screen.getByTestId('todo-add-task'))
    const input = (await screen.findByLabelText('任务描述')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '手动补一条' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() => {
      expect(vi.mocked(todoAPI.exec)).toHaveBeenCalledWith('s1', {
        op: 'append',
        phase: '阶段',
        items: ['手动补一条'],
      })
    })
  })

  it('折叠状态下也能打开新增行', async () => {
    vi.mocked(todoAPI.get).mockResolvedValue({
      phases: [{ name: '阶段', tasks: [{ content: '任务A', status: 'pending' }] }],
    })
    renderPanel()

    await screen.findByText('任务A')
    fireEvent.click(screen.getByText('本会话待办')) // 折叠
    expect(screen.queryByLabelText('任务描述')).toBeNull()

    fireEvent.click(screen.getByTestId('todo-add-task'))
    expect(await screen.findByLabelText('任务描述')).toBeInTheDocument()
  })
})

/**
 * 面板内容必须按会话收口。
 *
 * 缺陷：ChatPage→ChatView→ChatSession 的路由 path 不变、只有 sessionId 在换，
 * 组件实例复用，于是本面板的裸 useState（新任务输入、失败红字、导出提示）跟着
 * 上一条会话走：会话 A 里敲了一半的「修 A 的私活」原样出现在会话 B 的输入框里，
 * 回车即 append 进 **B 的待办列表**（实测 GET /api/todo/<B> 拿到那条任务、
 * <A> 为空）。此外 mutation 回调取的是最近一次渲染的闭包，在途期间切会话时
 * `setQueryData(todoKey)` 会把 A 的执行结果写进 B 的缓存 key，B 的面板整块显示成
 * A 的待办。
 */
describe('TodoPanel 会话级状态与缓存回写按会话收口', () => {
  /** 同一 QueryClient 下换 sessionId 重渲染（等价于侧栏切会话）。 */
  function renderFor(sessionId = 's1') {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const ui = (sid: string) => (
      <QueryClientProvider client={qc}>
        <TodoPanel sessionId={sid} projectId="p1" />
      </QueryClientProvider>
    )
    const view = render(ui(sessionId))
    return { qc, switchTo: (sid: string) => view.rerender(ui(sid)) }
  }

  it('切到另一条会话后，上一条会话没提交的新增文本不在新会话里', async () => {
    vi.mocked(todoAPI.get).mockResolvedValue({ phases: [] })
    const { switchTo } = renderFor('s1')

    fireEvent.click(await screen.findByTestId('todo-add-task'))
    fireEvent.change(await screen.findByLabelText('任务描述'), { target: { value: 'A 的私活' } })

    switchTo('s2')

    // 新增行收起；重新打开时是空的——B 的面板里不该留着 A 的半句话
    expect(screen.queryByLabelText('任务描述')).toBeNull()
    fireEvent.click(await screen.findByTestId('todo-add-task'))
    expect((await screen.findByLabelText('任务描述')) as HTMLInputElement).toHaveValue('')
  })

  it('在途 exec 的结果只写回原会话，不污染当前会话的待办', async () => {
    vi.mocked(todoAPI.get).mockResolvedValue({ phases: [] })
    let settle: (v: TodoOpResult) => void = () => {}
    vi.mocked(todoAPI.exec).mockImplementation(
      () =>
        new Promise<TodoOpResult>((res) => {
          settle = res
        }),
    )
    const { qc, switchTo } = renderFor('s1')

    fireEvent.click(await screen.findByTestId('todo-add-task'))
    fireEvent.change(await screen.findByLabelText('任务描述'), { target: { value: 'A 的任务' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    // mutate 到真正发出请求隔着一个微任务：等请求确实在途再切会话。
    await waitFor(() => expect(vi.mocked(todoAPI.exec).mock.calls.length).toBe(1))
    switchTo('s2')
    await act(async () => {
      settle({
        phases: [{ name: 'Tasks', tasks: [{ content: 'A 的任务', status: 'in_progress' }] }],
        output: 'added',
      })
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(qc.getQueryData(['todo', 's1'])).toMatchObject({
        phases: [{ tasks: [{ content: 'A 的任务' }] }],
      }),
    )
    expect(screen.getByTestId('todo-panel')).toHaveTextContent('暂无任务')
    expect(qc.getQueryData(['todo', 's2'])).toEqual({ phases: [] })
  })

  it('在途失败的原因不写到别的会话面板上', async () => {
    vi.mocked(todoAPI.get).mockResolvedValue({ phases: [] })
    let fail: (e: Error) => void = () => {}
    vi.mocked(todoAPI.exec).mockImplementation(
      () =>
        new Promise<TodoOpResult>((_res, rej) => {
          fail = rej
        }),
    )
    const { switchTo } = renderFor('s1')

    fireEvent.click(await screen.findByTestId('todo-add-task'))
    fireEvent.change(await screen.findByLabelText('任务描述'), { target: { value: 'A 的任务' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() => expect(vi.mocked(todoAPI.exec).mock.calls.length).toBe(1))
    switchTo('s2')
    await act(async () => {
      fail(new Error('待办服务不可用'))
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.getByTestId('todo-panel')).toHaveTextContent('暂无任务'))
    expect(screen.queryByText(/待办服务不可用/)).toBeNull()
  })
})
