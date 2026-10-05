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
