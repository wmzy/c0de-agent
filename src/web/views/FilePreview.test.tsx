import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FilePreview } from './FilePreview.js'

function withClient(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

afterEach(() => vi.restoreAllMocks())

describe('FilePreview', () => {
  it('渲染 markdown 文件', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ path: 'a.md', content: '# Title' }),
      }),
    )
    withClient(<FilePreview path="a.md" />)
    await waitFor(() => {
      expect(screen.getByText('加载中…')).toBeTruthy()
    })
  })
})
