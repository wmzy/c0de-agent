/**
 * KanbanView 读失败态回归测试。
 *
 * 缺陷一：失败态是一行纯文本「看板加载失败」——无原因、无重试入口。
 * 用户唯一出路是手动刷新整页；而看板是用户手动维护的数据源，
 * 「拉不到」若被读成「没有」，会让人以为卡片丢了。
 *
 * 缺陷二：错误文案若写成 `instanceof Error ? .message : String(err)`
 * 会渲染成「[object Object]」——APIError 是结构体
 * { status, message, code?, details? }（services/api.ts 的 toAPIError 返回），
 * 不是 Error 子类，instanceof 恒为 false。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { kanbanAPI } from '@/services/kanban.js'
import { KanbanView } from '@/views/KanbanView.js'

vi.mock('@/services/kanban.js', () => ({
  kanbanAPI: {
    get: vi.fn(),
    addCard: vi.fn(),
    updateCard: vi.fn(),
  },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderBoard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <KanbanView projectId="p1" />
    </QueryClientProvider>,
  )
}

/** 查询是异步的：先等失败态落地，再取元素，否则会撞上 isLoading 分支。 */
async function renderFailed() {
  const view = renderBoard()
  await screen.findByTestId('kanban-load-error')
  return view
}

describe('KanbanView 读失败态', () => {
  it('展示后端 message 而非 [object Object]，并给出重试入口', async () => {
    vi.mocked(kanbanAPI.get).mockRejectedValue({
      status: 500,
      code: 'X',
      message: '看板服务不可用',
    })
    await renderFailed()

    const box = screen.getByTestId('kanban-load-error')
    expect(box.textContent).toContain('看板加载失败')
    expect(box.textContent).toContain('看板服务不可用')
    expect(box.textContent).not.toContain('[object Object]')
    expect(screen.getByTestId('kanban-retry')).toBeInTheDocument()
  })

  it('网络异常（真正的 Error）也展示其 message', async () => {
    vi.mocked(kanbanAPI.get).mockRejectedValue(new TypeError('Failed to fetch'))
    await renderFailed()

    const box = screen.getByTestId('kanban-load-error')
    expect(box.textContent).toContain('Failed to fetch')
    expect(box.textContent).not.toContain('[object Object]')
  })

  it('失败态不得渲染看板主体（避免把读不到当成空看板）', async () => {
    vi.mocked(kanbanAPI.get).mockRejectedValue({ status: 500, message: 'boom' })
    await renderFailed()

    expect(screen.getByTestId('kanban-load-error')).toBeInTheDocument()
    expect(screen.queryByTestId('kanban-view')).toBeNull()
  })

  it('点击重试重新拉取看板', async () => {
    vi.mocked(kanbanAPI.get).mockRejectedValue({ status: 500, message: 'boom' })
    await renderFailed()

    vi.mocked(kanbanAPI.get).mockClear()
    fireEvent.click(screen.getByTestId('kanban-retry'))
    expect(kanbanAPI.get).toHaveBeenCalledWith('p1')
  })

  it('重试成功后从失败态恢复到看板主体', async () => {
    vi.mocked(kanbanAPI.get).mockRejectedValueOnce({ status: 500, message: 'boom' })
    await renderFailed()

    vi.mocked(kanbanAPI.get).mockResolvedValueOnce({
      id: 'b1',
      projectId: 'p1',
      columns: [{ id: 'col1', name: '待办' }],
      labels: [],
      cards: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    fireEvent.click(screen.getByTestId('kanban-retry'))

    expect(await screen.findByTestId('kanban-view')).toBeInTheDocument()
    expect(screen.queryByTestId('kanban-load-error')).toBeNull()
  })
})
/**
 * 横向溢出与焦点可达性回归。
 *
 * 列宽固定 280px，列数由用户自定义，5 列即 1472px——任何窄于此的视口都装不下。
 * 修复前：容器不可聚焦，Tab 走到第 5 列控件时 scrollLeft 恒为 0，
 * 控件落在视口外，键盘用户聚焦了看不见的东西；且除系统滚动条外
 * 没有任何「右边还有列」的提示（手机端系统滚动条整体不显示）。
 */
describe('KanbanView 横向溢出与键盘可达', () => {
  const boardOf = (columns: number) => ({
    id: 'b1',
    projectId: 'p1',
    columns: Array.from({ length: columns }, (_, i) => ({ id: `col${i}`, name: `列${i}` })),
    labels: [],
    cards: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })

  async function renderWithColumns(columns: number) {
    vi.mocked(kanbanAPI.get).mockResolvedValue(boardOf(columns))
    renderBoard()
    return screen.findByTestId('kanban-view')
  }

  it('看板列容器可聚焦且有可读名称（键盘用户需能滚动到后面的列）', async () => {
    await renderWithColumns(5)
    const board = document.querySelector('[aria-label="看板列，可横向滚动"]')
    expect(board).not.toBeNull()
    expect(board).toHaveAttribute('tabindex', '0')
  })

  it('焦点落到列内控件时把它横向滚入视口（不依赖引擎默认行为）', async () => {
    await renderWithColumns(5)
    const board = document.querySelector('[aria-label="看板列，可横向滚动"]') as HTMLElement
    const target = board.querySelector('button') as HTMLElement
    const scrollSpy = vi.spyOn(target, 'scrollIntoView')

    // React 17+ 把 onFocus 委托到根节点的 focusin 上，必须派发 focusin 才会触发。
    target.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))

    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
  })

  it('焦点来自容器外部时不劫持滚动（外层页面聚焦不该搅动看板）', async () => {
    await renderWithColumns(5)
    const board = document.querySelector('[aria-label="看板列，可横向滚动"]') as HTMLElement
    const inside = board.querySelector('button') as HTMLElement
    const scrollSpy = vi.spyOn(inside, 'scrollIntoView')

    // 焦点来自看板之外的控件：容器不该动任何一列
    const outside = document.createElement('button')
    outside.textContent = '外部按钮'
    document.body.appendChild(outside)
    board.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(scrollSpy).not.toHaveBeenCalled()
    outside.remove()
  })

  it('溢出时提示可横向滚动', async () => {
    // jsdom 不布局，clientWidth/scrollWidth 恒为 0，打桩驱动溢出分支
    const stub = (scrollWidth: number, clientWidth: number) => {
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        configurable: true,
        get: () => scrollWidth,
      })
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get: () => clientWidth,
      })
    }
    stub(1472, 1280)
    try {
      await renderWithColumns(5)
      expect(await screen.findByTestId('kanban-scroll-hint')).toHaveTextContent('共 5 列')
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth')
      Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
    }
  })

  it('不溢出时不显示滚动提示（提示是条件性的，不是常驻说明）', async () => {
    const stub = (scrollWidth: number, clientWidth: number) => {
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        configurable: true,
        get: () => scrollWidth,
      })
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get: () => clientWidth,
      })
    }
    stub(1472, 1600)
    try {
      await renderWithColumns(5)
      await screen.findByRole('region', { name: '看板列，可横向滚动' })
      expect(screen.queryByTestId('kanban-scroll-hint')).toBeNull()
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth')
      Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
    }
  })
})
