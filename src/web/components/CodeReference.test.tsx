import { createRoutes, MemoryRouter, View } from '@native-router/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantTextBlock } from '@/components/session/AssistantTextBlock.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// CodeReference 经 useMatched 读路由参数取 projectId：需要在内存路由里渲染，
// 且命中的路由必须带 :projectId（同 TopBar.test.tsx 的做法）。
const testRoutes = createRoutes({
  children: [
    { path: '/projects/:projectId', component: () => TestView },
    { path: '/projects/:projectId/sessions/:sessionId', component: () => TestView },
  ],
})

function TestView() {
  return <AssistantTextBlock text="@[src/a.ts:1-2]" />
}

async function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter routes={testRoutes} initialEntries={[path]}>
        <View />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  // 路由解析是异步的（懒加载/挂载链），等一拍再交互
  await act(async () => {})
}

function okBody(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ path: 'src/a.ts', content }),
    text: async () => JSON.stringify({ path: 'src/a.ts', content }),
  }
}

describe('CodeReference', () => {
  // 回归：引用里的路径是项目内相对路径，读文件必须带路由里的 projectId。
  // 不带时服务端把根落到自己的启动目录（ctx.cwd）——展开出来的可能是**另一个
  // 目录下同名文件**的内容，与消息里引用的文件毫无关系。
  it('展开引用时按路由项目读文件', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url))
        return okBody('line1\nline2')
      }),
    )
    await renderAt('/projects/p1/sessions/s1')
    fireEvent.click(screen.getByTestId('code-ref-toggle'))
    await waitFor(() => {
      expect(screen.getByTestId('code-ref-body').textContent).toContain('line1')
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/api/files/src/a.ts')
    expect(calls[0]).toContain('projectId=p1')
  })

  // 回归：失败此前只有一句固定的「读取失败」——路径写错/文件已删/服务端读不动
  // 全都长一个样，且没有重试入口，用户只能重开整页。
  it('读取失败时显示服务端原因并可重试', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ error: { code: 'NOT_FOUND', message: '文件不存在：src/a.ts' } }),
      text: async () =>
        JSON.stringify({ error: { code: 'NOT_FOUND', message: '文件不存在：src/a.ts' } }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    await renderAt('/projects/p1')
    fireEvent.click(screen.getByTestId('code-ref-toggle'))
    const errorBox = await screen.findByTestId('code-ref-error')
    expect(errorBox.textContent).toContain('文件不存在：src/a.ts')
    expect(errorBox.getAttribute('role')).toBe('alert')

    // 重试入口真的再发一次请求
    const before = fetchMock.mock.calls.length
    fireEvent.click(screen.getByTestId('code-ref-retry'))
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before)
    })
  })
})
