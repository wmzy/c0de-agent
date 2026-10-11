/**
 * BoardConfigDialog 删除标签的影响面回归测试。
 *
 * 缺陷：看板设置里标签行的「删除」是一次点击即生效的本地 state 操作，行内不显示
 * 这个标签被多少张卡片使用，保存时服务端「悬空引用清理」（src/kanban/store.ts）
 * 把该 labelId 从**整块看板所有卡片**上清掉。列删除有卡片数守卫（`该列中仍有 N
 * 张卡片，无法删除`），标签删除连「N 张卡片在用」都不展示——保护强度不对称。
 *
 * 契约：行内显示使用张数；有卡片在用时必须先确认（确认条列出受影响范围），
 * 未使用的标签仍可一次点击删除。
 *
 * 断言必须落在「删除后真正提交给 updateBoard 的 labels」上：只看弹窗里的行是否
 * 消失，无法区分「只是本地隐藏」与「保存会跨卡片生效」。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardConfigDialog } from '@/components/kanban/BoardConfigDialog.js'
import type { KanbanCard, KanbanLabelDef } from '@/services/kanban.js'
import { kanbanAPI } from '@/services/kanban.js'

vi.mock('@/services/kanban.js', () => ({
  kanbanAPI: {
    updateBoard: vi.fn(),
  },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const LABELS: KanbanLabelDef[] = [
  { id: 'lbl-bug', name: 'bug', color: '#ef4444' },
  { id: 'lbl-ux', name: 'ux', color: '#3b82f6' },
]

function card(id: string, labels: string[]): KanbanCard {
  return {
    id,
    boardId: 'board',
    title: id,
    description: null,
    columnId: 'todo',
    priority: 'medium',
    position: 1000,
    labels,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function renderDialog(cards: KanbanCard[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <BoardConfigDialog
        projectId="p1"
        columns={[{ id: 'todo', name: '待办' }]}
        labels={LABELS}
        cards={cards}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  )
}

describe('BoardConfigDialog 删除标签的影响面', () => {
  it('行内显示标签被多少张卡片使用', () => {
    renderDialog([card('c1', ['lbl-bug']), card('c2', ['lbl-bug', 'lbl-ux'])])
    expect(screen.getByText('2 卡在用')).toBeTruthy()
    expect(screen.getByText('1 卡在用')).toBeTruthy()
  })

  it('有卡片在用的标签：首次点击删除只给确认条，不改变提交内容', async () => {
    renderDialog([card('c1', ['lbl-bug']), card('c2', ['lbl-bug'])])
    fireEvent.click(screen.getByTestId('label-delete-lbl-bug'))

    const confirm = screen.getByTestId('label-delete-confirm-lbl-bug')
    // 确认条必须说清影响范围（张数），否则用户无从判断后果
    expect(confirm.textContent).toContain('2 张卡片')
    expect(confirm.textContent).toContain('会被清除')
    // 标签行仍在：这一步只是提示，不能已经把它移出待保存的 labels
    expect(screen.getByTestId('label-delete-lbl-bug')).toBeTruthy()

    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(kanbanAPI.updateBoard).toHaveBeenCalled())
    const patch = vi.mocked(kanbanAPI.updateBoard).mock.calls[0]?.[1]
    expect(patch?.labels?.map((l) => l.id)).toEqual(['lbl-bug', 'lbl-ux'])
  })

  it('确认删除后保存：该标签才从提交的 labels 里消失', async () => {
    renderDialog([card('c1', ['lbl-bug'])])
    fireEvent.click(screen.getByTestId('label-delete-lbl-bug'))
    fireEvent.click(screen.getByTestId('label-delete-confirm-ok-lbl-bug'))
    expect(screen.queryByTestId('label-delete-confirm-lbl-bug')).toBeNull()

    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(kanbanAPI.updateBoard).toHaveBeenCalled())
    const patch = vi.mocked(kanbanAPI.updateBoard).mock.calls[0]?.[1]
    expect(patch?.labels?.map((l) => l.id)).toEqual(['lbl-ux'])
  })

  it('取消确认则标签保留', async () => {
    renderDialog([card('c1', ['lbl-bug'])])
    fireEvent.click(screen.getByTestId('label-delete-lbl-bug'))
    fireEvent.click(screen.getByTestId('label-delete-confirm-cancel-lbl-bug'))
    expect(screen.queryByTestId('label-delete-confirm-lbl-bug')).toBeNull()

    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(kanbanAPI.updateBoard).toHaveBeenCalled())
    const patch = vi.mocked(kanbanAPI.updateBoard).mock.calls[0]?.[1]
    expect(patch?.labels?.map((l) => l.id)).toEqual(['lbl-bug', 'lbl-ux'])
  })

  it('未被任何卡片使用的标签仍可一次点击删除（不打扰）', async () => {
    renderDialog([card('c1', ['lbl-bug'])])
    expect(screen.getByText('未使用')).toBeTruthy()
    fireEvent.click(screen.getByTestId('label-delete-lbl-ux'))
    expect(screen.queryByTestId('label-delete-confirm-lbl-ux')).toBeNull()

    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(kanbanAPI.updateBoard).toHaveBeenCalled())
    const patch = vi.mocked(kanbanAPI.updateBoard).mock.calls[0]?.[1]
    expect(patch?.labels?.map((l) => l.id)).toEqual(['lbl-bug'])
  })
})
