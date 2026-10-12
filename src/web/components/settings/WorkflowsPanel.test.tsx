// WorkflowsPanel 组件测试，对应 src/web/components/settings/WorkflowsPanel.tsx
//
// 复现：面板的 useQuery 只解构了 `data`，`workflows = data?.workflows ?? []`
// 把「读取失败」与「确实为空」合成同一件事——GET /api/workflows 返回 500 或断网时，
// 用户看到的是一句关于现状的断言「暂无工作流。新建一个工作流脚本后可在聊天中用
// /workflow run 执行。」，即「你一个工作流都没有」。用户据此认定工作流不存在，
// 转而去重写一遍；同一次读取里的 trustRequired 提示（项目未信任，项目级工作流
// 已被隐藏）也被一并吞掉，与错误叠加成「既没有工作流、也没人告诉我为什么」。
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
