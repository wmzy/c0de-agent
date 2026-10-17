/**
 * CardEditDialog 标签作用域回归测试。
 *
 * 缺陷：卡片标签网格里每个标签都带一个「×」，点它会把这个标签从看板的
 * board.labels 里摘掉；保存时 updateBoard({labels}) 触发服务端「悬空引用清理」
 * （src/kanban/store.ts），把该 labelId 从**整块看板所有卡片**上删掉。
 * 实测：卡片甲里有 bug/ux，卡片乙里只有 bug；在「编辑卡片」弹窗里点 bug 的 ×
 * 并保存，卡片乙的 bug 也一起消失，且看板标签定义少了一条——弹窗标题只写着
 * 「编辑卡片」，用户无从预期跨卡片影响。
 *
 * 契约：本弹窗只表达「这张卡片带哪些标签」；标签定义的删除属于看板设置。
 * 因此 (1) 已持久化标签不渲染「×」；(2) 保存时发给 updateBoard 的 labels 恒为
 * 原 labels 的超集（只会多、不会少）。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CardEditDialog } from '@/components/kanban/CardEditDialog.js'
import type { KanbanLabelDef } from '@/services/kanban.js'
import { kanbanAPI } from '@/services/kanban.js'

vi.mock('@/services/kanban.js', () => ({
  kanbanAPI: {
    updateBoard: vi.fn(),
    updateCard: vi.fn(),
    deleteCard: vi.fn(),
  },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const BOARD_LABELS: KanbanLabelDef[] = [
  { id: 'lbl-bug', name: 'bug', color: '#ef4444' },
  { id: 'lbl-ux', name: 'ux', color: '#3b82f6' },
]

function renderDialog(initialLabels: string[] = ['lbl-bug'], onClose: () => void = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CardEditDialog
        projectId="p1"
        cardId="card-1"
        initialTitle="卡片甲"
        initialDescription={null}
        initialPriority="medium"
        initialLabels={initialLabels}
        boardLabels={BOARD_LABELS}
        onClose={onClose}
      />
    </QueryClientProvider>,
  )
}

describe('CardEditDialog 标签作用域', () => {
  it('已持久化标签没有删除入口（原本会连带删掉其它卡片的同一标签）', () => {
    renderDialog()
    expect(screen.queryByLabelText('删除标签 bug')).toBeNull()
    expect(screen.queryByLabelText('删除标签 ux')).toBeNull()
  })

  it('取消勾选标签只改本卡片，不触发 updateBoard', async () => {
    vi.mocked(kanbanAPI.updateCard).mockResolvedValue({} as never)
    renderDialog(['lbl-bug', 'lbl-ux'])

    // chip 主体是「本卡片带不带这个标签」的开关
    fireEvent.click(screen.getByRole('button', { name: 'bug' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(kanbanAPI.updateCard).toHaveBeenCalledTimes(1))
    expect(vi.mocked(kanbanAPI.updateCard).mock.calls[0]?.[2]).toMatchObject({
      labels: ['lbl-ux'],
    })
    // 标签定义没变 → 不得触碰看板配置（触碰即触发全卡片的悬空引用清理）
    expect(kanbanAPI.updateBoard).not.toHaveBeenCalled()
  })

  it('新增标签后保存，发给看板的 labels 是超集（不会少掉任何原有标签）', async () => {
    vi.mocked(kanbanAPI.updateBoard).mockResolvedValue({} as never)
    vi.mocked(kanbanAPI.updateCard).mockResolvedValue({} as never)
    renderDialog(['lbl-bug'])

    fireEvent.change(screen.getByLabelText('新标签名'), { target: { value: 'docs' } })
    fireEvent.click(screen.getByRole('button', { name: '+ 添加' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(kanbanAPI.updateBoard).toHaveBeenCalledTimes(1))
    const sent = vi.mocked(kanbanAPI.updateBoard).mock.calls[0]?.[1] as {
      labels: KanbanLabelDef[]
    }
    for (const id of ['lbl-bug', 'lbl-ux']) {
      expect(sent.labels.map((l) => l.id)).toContain(id)
    }
    expect(sent.labels.map((l) => l.name)).toContain('docs')
  })

  it('刚添加、尚未保存的标签可以撤销', () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('新标签名'), { target: { value: 'docs' } })
    fireEvent.click(screen.getByRole('button', { name: '+ 添加' }))
    expect(screen.getByRole('button', { name: 'docs' })).toBeTruthy()

    fireEvent.click(screen.getByLabelText('移除新标签 docs（尚未保存）'))
    expect(screen.queryByRole('button', { name: 'docs' })).toBeNull()
  })
})

/**
 * 提交型弹窗的在飞关闭契约（Dialog 的 closeDisabled）。
 *
 * 缺陷：保存/删除请求在飞时按 Esc / 点 ✕ / 点「取消」都会卸载弹窗，而唯一的
 * 失败原因（「操作失败：…」）画在弹窗内部——PATCH 失败（409 列冲突 / 500 / 断连）
 * 时用户看到的是「弹窗自己关了」，读成已保存，卡片其实还是旧标题；删除路径同理，
 * 以为删了其实没删。与 BoardConfigDialog / CommitReviewDialog 同一口径。
 */
describe('CardEditDialog 在飞期间不可关闭', () => {
  it('保存在飞时「取消」不关弹窗（失败原因不会被连带丢掉）', async () => {
    // 永不 resolve：把请求固定在「在飞」
    vi.mocked(kanbanAPI.updateCard).mockImplementation(() => new Promise(() => {}))
    const onClose = vi.fn()
    renderDialog(['lbl-bug'], onClose)

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(kanbanAPI.updateCard).toHaveBeenCalledTimes(1))

    const cancel = screen.getByRole('button', { name: '取消' }) as HTMLButtonElement
    expect(cancel.disabled).toBe(true)
    fireEvent.click(cancel)
    expect(onClose).not.toHaveBeenCalled()
    // 弹窗仍在：失败原因还有地方可画
    expect(screen.getByTestId('card-edit-overlay')).toBeTruthy()
  })

  it('保存失败时原因留在弹窗内并以 role=alert 播报', async () => {
    vi.mocked(kanbanAPI.updateCard).mockRejectedValue(new Error('卡片不存在'))
    const onClose = vi.fn()
    renderDialog(['lbl-bug'], onClose)

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    expect(screen.getByRole('alert').textContent).toContain('卡片不存在')
    expect(screen.getByTestId('card-edit-overlay')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    // 失败后请求不再在飞 → 关闭键恢复可用
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
