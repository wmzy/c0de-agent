/**
 * useSupportsVision 测试：能力查询必须带 projectId。
 *
 * 回归：ChatSession 此前 queryFn 只传 (provider, model)。服务端
 * `/api/providers/capabilities` 在没有 projectId 时回落到 **c0de 启动目录** 的
 * 配置与注册表（resolveForProject 直接 return ctx.config / ctx.llmRegistry），
 * 项目作用域里独有的模型解析不到 → 404 → `?? true` 静默按「支持视觉」处理，
 * 附件栏的「当前模型不支持图片」永不出现，贴图后由 provider 回 400。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSupportsVision } from '@/hooks/useSupportsVision.js'
import { providerAPI } from '@/services/provider.js'

vi.mock('@/services/provider.js', () => ({
  providerAPI: { capabilities: vi.fn() },
}))

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

const selection = { provider: 'proj-provider', model: 'proj-model' }

describe('useSupportsVision', () => {
  beforeEach(() => vi.mocked(providerAPI.capabilities).mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('按项目作用域查询：capabilities 带 projectId', async () => {
    vi.mocked(providerAPI.capabilities).mockResolvedValue({
      provider: 'proj-provider',
      model: 'proj-model',
      supportsVision: true,
      supportsThinking: false,
      contextWindow: 128000,
    })
    const { result } = renderHook(() => useSupportsVision('p1', selection), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current).toBe(true))
    expect(providerAPI.capabilities).toHaveBeenCalledWith('proj-provider', 'proj-model', 'p1')
  })

  it('项目模型不支持视觉 → false（附件栏据此警告/禁用图片入口）', async () => {
    vi.mocked(providerAPI.capabilities).mockResolvedValue({
      provider: 'proj-provider',
      model: 'proj-model',
      supportsVision: false,
      supportsThinking: true,
      contextWindow: 128000,
    })
    const { result } = renderHook(() => useSupportsVision('p1', selection), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('切项目重新查询（queryKey 含 projectId，不复用上一个项目的结论）', async () => {
    vi.mocked(providerAPI.capabilities).mockResolvedValue({
      provider: 'proj-provider',
      model: 'proj-model',
      supportsVision: false,
      supportsThinking: true,
      contextWindow: 128000,
    })
    const { result, rerender } = renderHook(({ pid }) => useSupportsVision(pid, selection), {
      wrapper: makeWrapper(),
      initialProps: { pid: 'p1' },
    })
    await waitFor(() => expect(result.current).toBe(false))

    vi.mocked(providerAPI.capabilities).mockResolvedValue({
      provider: 'proj-provider',
      model: 'proj-model',
      supportsVision: true,
      supportsThinking: true,
      contextWindow: 128000,
    })
    rerender({ pid: 'p2' })
    await waitFor(() => expect(result.current).toBe(true))
    expect(providerAPI.capabilities).toHaveBeenLastCalledWith('proj-provider', 'proj-model', 'p2')
  })

  // 能力查询是辅助校验：拿不到结论时按「支持」放行，而不是把图片入口整个关掉。
  it('尚未选定 provider/model 时不查询，且按支持处理', async () => {
    const { result } = renderHook(() => useSupportsVision('p1', { provider: '', model: '' }), {
      wrapper: makeWrapper(),
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(providerAPI.capabilities).not.toHaveBeenCalled()
    expect(result.current).toBe(true)
  })
})
