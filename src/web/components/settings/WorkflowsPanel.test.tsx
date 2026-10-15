// WorkflowsPanel 组件测试，对应 src/web/components/settings/WorkflowsPanel.tsx
//
// 复现：面板的 useQuery 只解构了 `data`，`workflows = data?.workflows ?? []`
// 把「读取失败」与「确实为空」合成同一件事——GET /api/workflows 返回 500 或断网时，
// 用户看到的是一句关于现状的断言「暂无工作流。新建一个工作流脚本后可在聊天中用
// /workflow run 执行。」，即「你一个工作流都没有」。用户据此认定工作流不存在，
// 转而去重写一遍；同一次读取里的 trustRequired 提示（项目未信任，项目级工作流
// 已被隐藏）也被一并吞掉，与错误叠加成「既没有工作流、也没人告诉我为什么」。
//
// 第二个缺陷（工作流编辑器丢脚本）：脚本只存在组件的本地 state 里（不进设置页的
// 配置草稿，因此页面的「未保存更改」拦不住它），而弹窗的 Esc / ✕ / 取消都直接
// setEditor(null)——一次按键静默丢掉整段手写脚本，没有任何确认、也无法恢复。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowsPanel } from '@/components/settings/WorkflowsPanel.js'
import { workflowsAPI } from '@/services/workflows.js'

vi.mock('@/services/workflows.js', () => ({
  workflowsAPI: {
    list: vi.fn(),
    get: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
  },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPanel(projectId?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <WorkflowsPanel projectId={projectId} />
    </QueryClientProvider>,
  )
}

describe('WorkflowsPanel 列表读取失败', () => {
  it('读失败时给出原因与重试，而不是断言「暂无工作流」', async () => {
    vi.mocked(workflowsAPI.list).mockRejectedValue(new Error('工作流服务 500'))

    renderPanel('p1')

    await waitFor(() => expect(screen.getByTestId('workflow-list-error')).toBeTruthy())
    expect(screen.getByTestId('workflow-list-error').textContent).toContain('工作流服务 500')
    // 「确实为空」这句话不能出现：把一次失败说成「你没有工作流」是本缺陷本身
    expect(screen.queryByText(/暂无工作流/)).toBeNull()
    // 新建入口不受影响——读失败不该让人失去唯一的自救手段
    expect(screen.getByTestId('workflow-add')).toBeTruthy()
  })

  it('点重试后重新请求，成功即恢复真实列表', async () => {
    vi.mocked(workflowsAPI.list)
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce({
        workflows: [{ name: 'deploy', description: '发布流程', source: 'project' }],
      })

    renderPanel('p1')
    await waitFor(() => expect(screen.getByTestId('workflow-list-error')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workflow-list-retry'))

    await waitFor(() => expect(screen.queryByTestId('workflow-list-error')).toBeNull())
    expect(screen.getByTestId('workflow-row').textContent).toContain('deploy')
  })

  // 失败态与空态必须同时被钉住：修好失败态最常见的回退是「两者都渲染/都不渲染」。
  it('确实没有工作流时仍然渲染「暂无工作流」', async () => {
    vi.mocked(workflowsAPI.list).mockResolvedValue({ workflows: [] })

    renderPanel('p1')

    await waitFor(() => expect(screen.getByText(/暂无工作流/)).toBeTruthy())
    expect(screen.queryByTestId('workflow-list-error')).toBeNull()
  })
})

describe('WorkflowsPanel 工作流编辑器不静默丢脚本', () => {
  /** 打开「新建」并往源码框里敲一段脚本（等价于用户从别处粘过来的整段工作流）。 */
  async function openCreateAndType(source: string) {
    vi.mocked(workflowsAPI.list).mockResolvedValue({ workflows: [] })
    renderPanel('p1')
    await waitFor(() => expect(screen.getByTestId('workflow-add')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workflow-add'))
    await waitFor(() => expect(screen.getByTestId('workflow-source-editor')).toBeTruthy())
    fireEvent.change(screen.getByTestId('workflow-source-editor'), { target: { value: source } })
    return screen.getByTestId('workflow-source-editor')
  }

  it('有未保存修改时点「取消」先确认，脚本不会被静默丢弃', async () => {
    await openCreateAndType('export default async () => { /* 手写脚本 */ }')

    fireEvent.click(screen.getByText('取消'))

    // 编辑器仍在 + 出现放弃确认：脚本还在框里
    expect(screen.getByTestId('workflow-source-editor')).toBeTruthy()
    expect(screen.getByText(/放弃未保存的工作流/)).toBeTruthy()
    // 「未保存的修改」提示同屏可见（用户知道为什么被拦下）
    expect(screen.getByTestId('workflow-unsaved-hint')).toBeTruthy()

    // 选「继续编辑」→ 回到编辑器，脚本原样保留
    fireEvent.click(screen.getByText('继续编辑'))
    expect(screen.queryByText(/放弃未保存的工作流/)).toBeNull()
    expect(
      (screen.getByTestId('workflow-source-editor') as HTMLTextAreaElement).value,
    ).toContain('手写脚本')

    // 再点取消 → 确认「放弃修改」→ 编辑器关闭
    fireEvent.click(screen.getByText('取消'))
    fireEvent.click(screen.getByText('放弃修改'))
    await waitFor(() => expect(screen.queryByTestId('workflow-source-editor')).toBeNull())
  })

  it('没有改动时「取消」直接关闭（不弹确认）', async () => {
    vi.mocked(workflowsAPI.list).mockResolvedValue({ workflows: [] })
    renderPanel('p1')
    await waitFor(() => expect(screen.getByTestId('workflow-add')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workflow-add'))
    await waitFor(() => expect(screen.getByTestId('workflow-source-editor')).toBeTruthy())

    fireEvent.click(screen.getByText('取消'))

    await waitFor(() => expect(screen.queryByTestId('workflow-source-editor')).toBeNull())
    expect(screen.queryByText(/放弃未保存的工作流/)).toBeNull()
  })

  it('保存中关闭被拦下：弹窗与草稿都留着（失败原因不能随弹窗一起消失）', async () => {
    // 永远在途的保存：模拟慢请求
    vi.mocked(workflowsAPI.save).mockImplementation(() => new Promise(() => {}))
    await openCreateAndType('export default async () => {}')
    fireEvent.change(screen.getByTestId('workflow-name-input'), { target: { value: 'slow-flow' } })

    fireEvent.click(screen.getByTestId('workflow-save'))
    await waitFor(() => expect(screen.getByText('保存中…')).toBeTruthy())

    fireEvent.click(screen.getByText('取消'))

    expect(screen.getByTestId('workflow-source-editor')).toBeTruthy()
    expect(screen.queryByText(/放弃未保存的工作流/)).toBeNull()
    expect((screen.getByTestId('workflow-source-editor') as HTMLTextAreaElement).value).toContain(
      'export default',
    )
  })
})
