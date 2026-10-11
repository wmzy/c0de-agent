/**
 * ArchivePanel 测试：归档列表的「加载失败」必须与「真的没有归档」区分开。
 *
 * 回归：组件只取 data/isLoading 两个状态位，请求 500 时 data 为 undefined
 * → archives 恒为 []，与空态落进同一分支，弹层稳定显示「暂无归档
 * （/clear、Shake、压缩产生的内容会保留在这里）」——用户据此认定历史内容丢了，
 * 而实际只是这次没读到。实测（浏览器注入 500）修复前就是这句空态文案。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArchivePanel } from '@/components/ArchivePanel.js'

vi.mock('@/services/session.js', () => ({
  sessionAPI: {
    archives: vi.fn(),
  },
}))

const { sessionAPI } = await import('@/services/session.js')
const archives = sessionAPI.archives as Mock

beforeEach(() => {
  // mockReset 而非 clearAllMocks：把实现一并清掉，避免上个用例设置的
  // 拒绝/一次性实现泄漏到下一个用例。
  archives.mockReset()
})

afterEach(() => {
  cleanup()
})

function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <ArchivePanel sessionId="s1" onClose={() => {}} />
    </QueryClientProvider>,
  )
}

describe('ArchivePanel 读取失败', () => {
  it('500 时给出失败原因与重试入口，不显示「暂无归档」', async () => {
    archives.mockRejectedValue(new Error('归档查询失败：数据库忙'))
    renderPanel()

    const err = await screen.findByTestId('archive-load-error')
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toContain('归档加载失败')
    expect(err.textContent).toContain('数据库忙')
    expect(screen.getByTestId('archive-retry')).toBeTruthy()
    // 「没有归档」是另一件事，不能在读失败时出现
    expect(screen.queryByText(/暂无归档/)).toBeNull()
  })

  it('重试后成功则改显列表', async () => {
    archives.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({
      archives: [
        {
          id: 'a1',
          archiveType: 'compaction',
          summary: '压缩掉 12 条旧消息',
          tokenCount: 1234,
          createdAt: 1719380000000,
          originalEntries: [{ role: 'user', content: [{ _tag: 'text', text: 'hi' }] }],
        },
      ],
    })
    renderPanel()

    await screen.findByTestId('archive-load-error')
    fireEvent.click(screen.getByTestId('archive-retry'))

    await waitFor(() => {
      expect(screen.getByText('压缩掉 12 条旧消息')).toBeTruthy()
    })
    expect(screen.queryByTestId('archive-load-error')).toBeNull()
  })

  it('真的没有归档时才是空态（且不出现失败提示）', async () => {
    archives.mockResolvedValue({ archives: [] })
    renderPanel()

    await waitFor(() => {
      expect(screen.getByText(/暂无归档/)).toBeTruthy()
    })
    expect(screen.queryByTestId('archive-load-error')).toBeNull()
  })
})
