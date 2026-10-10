/**
 * UsagePanel 组件测试，对应 src/web/components/settings/UsagePanel.tsx。
 * 覆盖：token 预算护栏的可观察契约——warn 模式下 token 超支须显示告警与生效提示，
 * 而非静默（P1 产品修复：#2 token 预算在默认 'warn' 下曾是死旋钮）。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Mock } from 'vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UsagePanel } from '@/components/settings/UsagePanel.js'

vi.mock('@/services/usage.js', () => ({
  usageAPI: { summary: vi.fn() },
}))

function renderPanel(props: Parameters<typeof UsagePanel>[0]): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  render(wrap(<UsagePanel {...props} />))
}

function baseSummary(overrides: Partial<{ inputTokens: number; outputTokens: number }> = {}) {
  return {
    priceCatalogVersion: 'test',
    totals: {
      inputTokens: overrides.inputTokens ?? 0,
      outputTokens: overrides.outputTokens ?? 0,
      cacheRead: 0,
      cost: 0,
      unknownCostCalls: 0,
      calls: 0,
    },
    currentMonth: {
      key: '2026-09',
      inputTokens: overrides.inputTokens ?? 0,
      outputTokens: overrides.outputTokens ?? 0,
      cacheRead: 0,
      cost: 0,
      unknownCostCalls: 0,
      calls: 0,
    },
    byMonth: [],
    byModel: [],
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('UsagePanel — token 预算护栏', () => {
  it('warn 模式 token 超支 → 显示告警与生效提示（不再静默）', async () => {
    const { usageAPI } = await import('@/services/usage.js')
    ;(usageAPI.summary as Mock).mockResolvedValue(
      baseSummary({ inputTokens: 1500, outputTokens: 0 }),
    )

    renderPanel({
      budget: 0,
      budgetAction: 'warn',
      globalBudget: 0,
      tokenBudget: 1000,
      globalTokenBudget: 0,
      onBudgetChange: vi.fn(),
      onBudgetActionChange: vi.fn(),
      onGlobalBudgetChange: vi.fn(),
      onTokenBudgetChange: vi.fn(),
      onGlobalTokenBudgetChange: vi.fn(),
      projectId: 'proj-1',
    })

    expect(await screen.findByTestId('usage-token-budget-warning')).toBeTruthy()
    expect(screen.getByTestId('usage-token-budget-hint')).toBeTruthy()
  })

  it('token 未超支 → 不显示告警', async () => {
    const { usageAPI } = await import('@/services/usage.js')
    ;(usageAPI.summary as Mock).mockResolvedValue(baseSummary({ inputTokens: 10, outputTokens: 0 }))

    renderPanel({
      budget: 0,
      budgetAction: 'warn',
      globalBudget: 0,
      tokenBudget: 1000,
      globalTokenBudget: 0,
      onBudgetChange: vi.fn(),
      onBudgetActionChange: vi.fn(),
      onGlobalBudgetChange: vi.fn(),
      onTokenBudgetChange: vi.fn(),
      onGlobalTokenBudgetChange: vi.fn(),
      projectId: 'proj-1',
    })

    // 稍等一次 query 解析，再断言无告警节点。
    await screen.findByTestId('usage-panel')
    expect(screen.queryByTestId('usage-token-budget-warning')).toBeNull()
  })

  it('全局视图渲染全局 token 预算输入框', async () => {
    const { usageAPI } = await import('@/services/usage.js')
    ;(usageAPI.summary as Mock).mockResolvedValue(baseSummary())

    renderPanel({
      budget: 0,
      budgetAction: 'warn',
      globalBudget: 0,
      tokenBudget: 0,
      globalTokenBudget: 0,
      onBudgetChange: vi.fn(),
      onBudgetActionChange: vi.fn(),
      onGlobalBudgetChange: vi.fn(),
      onTokenBudgetChange: vi.fn(),
      onGlobalTokenBudgetChange: vi.fn(),
      projectId: undefined,
    })

    expect(await screen.findByTestId('usage-global-token-budget')).toBeTruthy()
  })

  it('金额预算已设但未设 token 预算 + 价格未知调用 → 提示设置 token 预算兜底', async () => {
    const { usageAPI } = await import('@/services/usage.js')
    const summary = baseSummary()
    summary.totals.unknownCostCalls = 3
    ;(usageAPI.summary as Mock).mockResolvedValue(summary)

    renderPanel({
      budget: 10,
      budgetAction: 'warn',
      globalBudget: 0,
      tokenBudget: 0,
      globalTokenBudget: 0,
      onBudgetChange: vi.fn(),
      onBudgetActionChange: vi.fn(),
      onGlobalBudgetChange: vi.fn(),
      onTokenBudgetChange: vi.fn(),
      onGlobalTokenBudgetChange: vi.fn(),
      projectId: 'proj-1',
    })

    const warn = await screen.findByTestId('usage-unknown-cost-warning')
    expect(warn.textContent).toContain('token 预算兜底')
  })

  it('已设 token 预算时，价格未知调用的告警不含兜底引导', async () => {
    const { usageAPI } = await import('@/services/usage.js')
    const summary = baseSummary()
    summary.totals.unknownCostCalls = 3
    ;(usageAPI.summary as Mock).mockResolvedValue(summary)

    renderPanel({
      budget: 10,
      budgetAction: 'warn',
      globalBudget: 0,
      tokenBudget: 1000,
      globalTokenBudget: 0,
      onBudgetChange: vi.fn(),
      onBudgetActionChange: vi.fn(),
      onGlobalBudgetChange: vi.fn(),
      onTokenBudgetChange: vi.fn(),
      onGlobalTokenBudgetChange: vi.fn(),
      projectId: 'proj-1',
    })

    const warn = await screen.findByTestId('usage-unknown-cost-warning')
    expect(warn.textContent).not.toContain('token 预算兜底')
  })

  // 回归：金额展示直接 toFixed——二进制近似把 1.005 舍成 1.00（少一分钱）。
  it('成本金额按十进制舍入展示（1.005 → $1.01）', async () => {
    const { usageAPI } = await import('@/services/usage.js')
    const summary = {
      ...baseSummary(),
      byModel: [
        {
          model: 'm1',
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cost: 1.005,
          unknownCostCalls: 0,
          calls: 1,
        },
      ],
    }
    ;(usageAPI.summary as Mock).mockResolvedValue(summary)

    renderPanel({
      budget: 0,
      budgetAction: 'warn',
      globalBudget: 0,
      tokenBudget: 0,
      globalTokenBudget: 0,
      onBudgetChange: vi.fn(),
      onBudgetActionChange: vi.fn(),
      onGlobalBudgetChange: vi.fn(),
      onTokenBudgetChange: vi.fn(),
      onGlobalTokenBudgetChange: vi.fn(),
      projectId: 'proj-1',
    })

    expect(await screen.findByText('$1.01')).toBeTruthy()
  })
})

/**
 * 读不到 ≠ 没有。
 *
 * 回归：用量查询失败时 data 为 undefined，cost/token 全部回落 0，面板照常渲染
 * 「本月 $0.00、无超支、空账本」——用户据此认为本月零花费、预算安全，实际上
 * 什么都没读到。同 SessionSummary 的「读不到」口径：说明原因 + 重试，且统计表
 * 整段不渲染。
 */
describe('UsagePanel — 读不到不等于 $0', () => {
  const props = {
    budget: 0,
    budgetAction: 'warn' as const,
    globalBudget: 0,
    tokenBudget: 0,
    globalTokenBudget: 0,
    onBudgetChange: vi.fn(),
    onBudgetActionChange: vi.fn(),
    onGlobalBudgetChange: vi.fn(),
    onTokenBudgetChange: vi.fn(),
    onGlobalTokenBudgetChange: vi.fn(),
    projectId: 'proj-1',
  }

  it('查询失败 → 报出后端原因 + 重试，且不渲染任何统计数字', async () => {
    const { usageAPI } = await import('@/services/usage.js')
    ;(usageAPI.summary as Mock).mockRejectedValue(new Error('usage summary 500'))

    renderPanel(props)

    const box = await screen.findByTestId('usage-load-error')
    expect(box.textContent).toContain('usage summary 500')
    expect(screen.getByTestId('usage-retry')).toBeTruthy()
    // 空账本（表头 + 零行）本身就是「本月一次调用都没发生」的读法
    expect(screen.queryByText('月度')).toBeNull()
    expect(screen.queryByText('模型')).toBeNull()
    expect(screen.queryByTestId('usage-budget-warning')).toBeNull()
  })

  it('重试按钮重新发起查询', async () => {
    const { usageAPI } = await import('@/services/usage.js')
    ;(usageAPI.summary as Mock).mockRejectedValue(new Error('boom'))
    renderPanel(props)
    await screen.findByTestId('usage-load-error')

    ;(usageAPI.summary as Mock).mockResolvedValue(baseSummary())
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.click(screen.getByTestId('usage-retry'))

    expect((usageAPI.summary as Mock).mock.calls.length).toBeGreaterThan(1)
    await screen.findByText('月度')
  })

  it('加载中不谎报空账本', async () => {
    const { usageAPI } = await import('@/services/usage.js')
    ;(usageAPI.summary as Mock).mockReturnValue(new Promise(() => {}))

    renderPanel(props)

    expect(await screen.findByTestId('usage-loading')).toBeTruthy()
    expect(screen.queryByText('月度')).toBeNull()
  })
})
