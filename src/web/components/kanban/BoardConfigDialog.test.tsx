/**
 * BoardConfigDialog 的两条回归：标签删除的影响面、保存期间不可关闭。
 *
 * 一、删除标签的影响面。缺陷：看板设置里标签行的「删除」是一次点击即生效的本地
 * state 操作，行内不显示这个标签被多少张卡片使用，保存时服务端「悬空引用清理」
 * （src/kanban/store.ts）把该 labelId 从**整块看板所有卡片**上清掉。列删除有卡片
 * 数守卫（`该列中仍有 N 张卡片，无法删除`），标签删除连「N 张卡片在用」都不展示
 * ——保护强度不对称。
 *
 * 契约：行内显示使用张数；有卡片在用时必须先确认（确认条列出受影响范围），
 * 未使用的标签仍可一次点击删除。
 *
 * 断言必须落在「删除后真正提交给 updateBoard 的 labels」上：只看弹窗里的行是否
 * 消失，无法区分「只是本地隐藏」与「保存会跨卡片生效」。
 *
 * 二、保存期间不可关闭。缺陷：这是「提交型弹窗漏接 closeDisabled」的又一漏网
 * （同族已修：DangerConfirmDialog / AddProjectDialog / RelocateProjectDialog /
 * CommitReviewDialog），请求在飞时 Esc / ✕ / 点背景 / 取消都能把面板卸载——保存
 * 承载的列改名、增删列、标签改名改色全被当成「已保存」，随后失败的原因（只渲染
 * 在这块面板里）也无处可报。
 *
 * 契约：请求在飞时所有关闭出口都拒绝；失败原因留在面板里可见，busy 回落后关闭
 * 出口恢复；保存成功照旧关闭。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardConfigDialog } from '@/components/kanban/BoardConfigDialog.js'
import type { KanbanBoard, KanbanCard, KanbanLabelDef } from '@/services/kanban.js'
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

function renderDialog(cards: KanbanCard[], onClose: () => void = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <BoardConfigDialog
        projectId="p1"
        columns={[{ id: 'todo', name: '待办' }]}
        labels={LABELS}
        cards={cards}
        onClose={onClose}
      />
    </QueryClientProvider>,
  )
}

/** <dialog> 上的 Esc：浏览器把它变成面板的 cancel 事件（Dialog 原语正是在这条
 *  路径上拦截关闭意图），happy-dom 不会由按键自己派发，这里派发同一事件。
 *  haze 收到 cancel 后要等 exit-settle 才真正 close()（异步），所以「有没有被
 *  关掉」必须等这一拍再断言，否则读到的是关闭前的旧态，断言恒过。 */
async function escDialog() {
  const dialog = document.querySelector('dialog')
  if (!dialog) throw new Error('面板未渲染')
  fireEvent(dialog, new Event('cancel'))
  await new Promise((r) => setTimeout(r, 20))
  return dialog as HTMLDialogElement
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

/**
 * 保存请求在飞时的关闭出口。
 *
 * 缺陷：板配置弹窗是「提交型弹窗没接 closeDisabled」的漏网——Esc / ✕ / 点背景 /
 * 取消都直接走裸 onClose，请求在飞时按一下就整块卸载面板；而这一次保存承载的是
 * 列改名、增删列、标签改名改色、删标签，用户看到「弹窗自己关了」，只能理解成
 * 「保存成功」，实际服务端还没答；请求随后失败时，那条唯一的原因就渲染在这块
 * 已被卸载的面板里，无处可报。旧实现里「取消」按钮同样不 disabled，请求在飞时
 * 连点还会重排第二次保存。
 */
describe('BoardConfigDialog 保存期间不可关闭', () => {
  it('请求在飞：Esc / ✕ / 取消都不关面板，面板里的提示不随之消失', async () => {
    let finishSave: () => void = () => {}
    vi.mocked(kanbanAPI.updateBoard).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({} as KanbanBoard)
        }) as ReturnType<typeof kanbanAPI.updateBoard>,
    )
    const onClose = vi.fn()
    renderDialog([card('c1', [])], onClose)

    // 面板里先造一条与保存无关的用户可见提示（这一列还有卡片，不能删）：
    // 关闭面板会把它一并带走。
    fireEvent.click(screen.getByTitle('该列中仍有卡片，需先移动或删除卡片'))
    expect(screen.getByTestId('board-config-error').textContent).toContain('无法删除')

    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(kanbanAPI.updateBoard).toHaveBeenCalled())

    const dialog = await escDialog()
    const closeBtn = screen.getByRole('button', { name: '关闭' }) as HTMLButtonElement
    const cancelBtn = screen.getByText('取消') as HTMLButtonElement
    fireEvent.click(closeBtn)
    fireEvent.click(cancelBtn)

    // 三条关闭尝试（Esc / ✕ / 取消）一个都不许把面板带走：用户看到「弹窗自己关了」
    // 只能理解成保存成功，而列改名、增删列、标签改名改色此时都还没落库。
    expect(onClose).not.toHaveBeenCalled()
    // 面板仍是打开的原生 <dialog>（Esc 被原语在捕获阶段拦下），而不是「DOM 还在、弹层已非模态」
    expect(dialog.open).toBe(true)
    // 关闭键与取消自己先拒绝点击，而不是靠点击后的空操作
    expect(closeBtn.disabled).toBe(true)
    expect(cancelBtn.disabled).toBe(true)
    // 面板里那条提示还看得见——它只活在这块面板里，关掉面板就随之消失
    expect(screen.getByTestId('board-config-error').textContent).toContain('无法删除')

    // 请求成功落地后照旧关闭：护栏只为「在飞」服务，不会把弹窗焊死
    finishSave()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('保存失败：原因留在面板里可见，此时 Esc / 取消又能关掉', async () => {
    vi.mocked(kanbanAPI.updateBoard).mockRejectedValue(new Error('列名不能为空'))
    const onClose = vi.fn()
    renderDialog([], onClose)

    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>
      expect(screen.getByTestId('board-config-error').textContent).toContain('列名不能为空'),
    )

    // 失败后请求已落地（busy 回落），关闭出口恢复
    expect((screen.getByText('取消') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByText('取消'))
    expect(onClose).toHaveBeenCalledTimes(1)
    // 关掉之前原因一直是可见的——旧实现里它随面板一起消失，用户只看到弹窗自关
    expect(screen.getByTestId('board-config-error').textContent).toContain('列名不能为空')
  })

  it('失败后 Esc 也能关（与取消同一出口）', async () => {
    vi.mocked(kanbanAPI.updateBoard).mockRejectedValue(new Error('列名不能为空'))
    const onClose = vi.fn()
    renderDialog([], onClose)

    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>
      expect(screen.getByTestId('board-config-error').textContent).toContain('列名不能为空'),
    )

    await escDialog()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
