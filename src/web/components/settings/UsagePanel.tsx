import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import type { UsageSummary } from '../../services/usage.js'
import { usageAPI } from '../../services/usage.js'
import { field, fieldInput, hint, section, sectionTitle } from './styles.js'

const rowGrid = css`
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  gap: 4px 16px;
  font-size: 12px;
  padding: 2px 0;
  border-bottom: 1px solid var(--border);

  & > span:nth-child(n + 2) {
    text-align: right;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
`

const headRow = css`
  ${rowGrid};
  color: var(--text-secondary);
  font-weight: 600;
  border-bottom: none;
`

const budgetWarn = css`
  color: var(--warning);
  font-size: 12px;
  margin-top: 6px;
`

const fmtTokens = (n: number): string => n.toLocaleString('en-US')

const fmtCost = (n: number): string => `$${n.toFixed(2)}`

function currentMonthCost(summary: UsageSummary | undefined): number {
  if (!summary) return 0
  const now = new Date().toISOString().slice(0, 7)
  return summary.byMonth.find((m) => m.month === now)?.cost ?? 0
}

/**
 * 用量与成本面板（P2 成本聚合视图）：
 * - 总量 + 按月 + 按模型统计（成本按配置价目估算，与会话信息面板口径一致）；
 * - 月度预算告警：当前月成本超过 monthlyBudgetUsd 时醒目提示（0 = 不限制）。
 */
function UsagePanel({
  budget,
  onBudgetChange,
}: {
  budget: number
  onBudgetChange: (v: number) => void
}) {
  const { data: summary } = useQuery({
    queryKey: ['usage', 'summary'],
    queryFn: () => usageAPI.summary(),
    staleTime: 30_000,
  })

  const monthCost = currentMonthCost(summary)
  const overBudget = budget > 0 && monthCost > budget
  // H2：价格未知的调用按 $0 计入，显式提示成本可能低估。
  const unknownCostTotal = summary?.totals.unknownCostCalls ?? 0
  // L2：无时间戳调用归入「未知」月份，不参与本月预算比较——同样需要提示。
  const unknownMonth = summary?.byMonth.find((m) => m.month === '未知')

  return (
    <div className={section} data-testid="usage-panel">
      <h2 className={sectionTitle}>用量与成本</h2>
      <div className={hint}>
        统计全部会话（含回收站内已删除会话）的 LLM 调用；成本按 provider 价目估算
        {summary ? `（价目版本 ${summary.priceCatalogVersion}，实际费用以账单为准）` : ''}。
      </div>
      <label className={field}>
        <span>月度成本预算 (USD，0 = 不限制)</span>
        <input
          className={fieldInput}
          type="number"
          min={0}
          step="0.5"
          value={budget}
          onChange={(e) => onBudgetChange(Math.max(0, Number(e.target.value)))}
        />
      </label>
      {overBudget && (
        <div className={budgetWarn} data-testid="usage-budget-warning">
          ⚠ 本月成本 ${monthCost.toFixed(2)} 已超过预算 ${budget.toFixed(2)}
        </div>
      )}
      {unknownCostTotal > 0 && (
        <div className={budgetWarn} data-testid="usage-unknown-cost-warning">
          ⚠ {unknownCostTotal} 次调用价格未知（自建网关/未登记模型），按 $0
          计入——实际成本可能高于显示值。
        </div>
      )}
      {unknownMonth && unknownMonth.calls > 0 && (
        <div className={hint}>
          另有 {unknownMonth.calls} 次无时间戳调用（合计 {fmtCost(unknownMonth.cost)}
          ）未计入本月预算比较。
        </div>
      )}
      <div className={headRow}>
        <span>月度</span>
        <span>调用</span>
        <span>Token</span>
        <span>成本</span>
      </div>
      {(summary?.byMonth ?? []).map((m) => (
        <div className={rowGrid} key={m.month}>
          <span>{m.month === '未知' ? '（无时间戳）' : m.month}</span>
          <span>{m.calls}</span>
          <span>{fmtTokens(m.inputTokens + m.outputTokens + m.cacheRead)}</span>
          <span>{fmtCost(m.cost)}</span>
        </div>
      ))}
      <div className={headRow} style={{ marginTop: 10 }}>
        <span>模型</span>
        <span>调用</span>
        <span>Token</span>
        <span>成本</span>
      </div>
      {(summary?.byModel ?? []).map((m) => (
        <div className={rowGrid} key={m.model}>
          <span title={m.model}>{m.model}</span>
          <span>{m.calls}</span>
          <span>{fmtTokens(m.inputTokens + m.outputTokens + m.cacheRead)}</span>
          <span>{fmtCost(m.cost)}</span>
        </div>
      ))}
      {summary && (
        <div className={rowGrid} style={{ fontWeight: 600 }}>
          <span>累计</span>
          <span>{summary.totals.calls}</span>
          <span>
            {fmtTokens(
              summary.totals.inputTokens + summary.totals.outputTokens + summary.totals.cacheRead,
            )}
          </span>
          <span>{fmtCost(summary.totals.cost)}</span>
        </div>
      )}
    </div>
  )
}

export { UsagePanel }
