// ProviderPanel 组件测试，对应 src/web/components/settings/ProviderPanel.tsx
//
// 复现：测试连接结果按**数组下标**索引（testResults[index]），而行的身份也是下标——
// 删除下标更小的行后所有后续行前移，旧结果却留在原下标：A 的测试结果会显示在
// B 行、B 的显示在 C 行（"✓ 连接成功，N 个模型" 指向错误的 provider，用户据此
// 以为某 provider 可用）。
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderPanel } from '@/components/settings/ProviderPanel.js'
import { providerAPI } from '@/services/provider.js'

vi.mock('@/services/provider.js', () => ({
  providerAPI: { test: vi.fn(), list: vi.fn(), capabilities: vi.fn() },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

type Provider = {
  name: string
  protocol: 'openai'
  apiKey: string
  baseURL: string
}

const A: Provider = { name: 'a', protocol: 'openai', apiKey: 'ka', baseURL: 'https://a/v1' }
const B: Provider = { name: 'b', protocol: 'openai', apiKey: 'kb', baseURL: 'https://b/v1' }
const C: Provider = { name: 'c', protocol: 'openai', apiKey: 'kc', baseURL: 'https://c/v1' }

/** 受控宿主：与 Settings 一致地以函数式更新应用 provider 变更。 */
function Harness() {
  const [providers, setProviders] = useState<Provider[]>([A, B, C])
  return (
    <ProviderPanel
      providers={providers}
      onProvidersChange={(updater) => setProviders((prev) => updater(prev) as Provider[])}
    />
  )
}

describe('ProviderPanel', () => {
  it('删除行后测试结果跟随行移动，不串位到其他行', async () => {
    vi.mocked(providerAPI.test).mockResolvedValue({ ok: true, models: ['m1'] })
    render(<Harness />)

    // 测试第 2 行（B）
    fireEvent.click(screen.getAllByTestId('provider-test')[1] as HTMLElement)
    await waitFor(() => expect(providerAPI.test).toHaveBeenCalledWith('https://b/v1', 'kb'))
    await waitFor(() => {
      const rows = screen.getAllByTestId('provider-row')
      expect(within(rows[1] as HTMLElement).getByText(/连接成功/)).toBeTruthy()
    })

    // 删除第 1 行（A）→ B 上移到下标 0、C 上移到下标 1
    fireEvent.click(screen.getAllByTestId('provider-remove')[0] as HTMLElement)

    const rows = screen.getAllByTestId('provider-row')
    expect(rows).toHaveLength(2)
    // B（现第 1 行）保留自己的测试结果
    expect(within(rows[0] as HTMLElement).getByText(/连接成功/)).toBeTruthy()
    // C（现第 2 行）不得显示任何测试结果（此前显示 B 的结果——串位）
    expect(within(rows[1] as HTMLElement).queryByText(/连接成功/)).toBeNull()
  })
})
