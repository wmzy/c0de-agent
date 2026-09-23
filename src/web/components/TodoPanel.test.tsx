/**
 * TodoPanel「导出到看板」语义：导出不得假定看板列配置（列 id 由用户维护，
 * 可被改名/删除或经导入替换）——目标列由看板 store 按板的首列决定。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TodoPanel } from '@/components/TodoPanel.js'
import { kanbanAPI } from '@/services/kanban.js'
import { todoAPI } from '@/services/todo.js'

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
