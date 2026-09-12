import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import type { UsageSummary } from '../../services/usage.js'
import { usageAPI } from '../../services/usage.js'
import {
  monthTokenSum,
  resolveEffectiveBudget,
  resolveEffectiveTokenBudget,
} from '../../utils/usage.js'
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

/** P1-4：本月口径由服务端下发（summary.currentMonth），客户端不再自行按时区计算。 */
function currentMonthCost(summary: UsageSummary | undefined): number {
  return summary?.currentMonth?.cost ?? 0
}

/**
 * 用量与成本面板（P2 成本聚合视图）：
 * - 总量 + 按月 + 按模型统计（成本按配置价目估算，与会话信息面板口径一致）；
 * - 月度预算告警：当前月成本超过 monthlyBudgetUsd 时醒目提示（0 = 不限制）。
 * P1：projectId 提供时统计与预算均为本项目口径（项目配置的预算配本项目成本），
 * 其他项目的花费不再触发本项目的预算告警。
 */
function UsagePanel({
  budget,
  budgetAction,
  globalBudget,
  tokenBudget,
  globalTokenBudget,
  onBudgetChange,
  onBudgetActionChange,
  onGlobalBudgetChange,
  onTokenBudgetChange,
  onGlobalTokenBudgetChange,
  projectId,
}: {
  budget: number
  budgetAction?: string
  globalBudget?: number
  tokenBudget?: number
  globalTokenBudget?: number
  onBudgetChange: (v: number) => void
  onBudgetActionChange: (v: 'warn' | 'pause') => void
  onGlobalBudgetChange?: (v: number) => void
  onTokenBudgetChange?: (v: number) => void
  onGlobalTokenBudgetChange?: (v: number) => void
  projectId?: string
}) {
  const { data: summary } = useQuery({
    queryKey: ['usage', 'summary', projectId ?? 'all'],
    queryFn: () => usageAPI.summary(projectId),
    staleTime: 30_000,
  })

  const monthCost = currentMonthCost(summary)
  // token 口径与预算暂停判定同源（input+output+cacheRead）。
  const monthTokens = monthTokenSum(summary?.currentMonth)
  // 项目视图：项目预算；全局视图：全局预算（P1-3 两者并存，任一超支即触发动作）。
  const effectiveBudget = resolveEffectiveBudget(projectId, budget, globalBudget)
  const overBudget = effectiveBudget > 0 && monthCost > effectiveBudget
  const nearBudget = effectiveBudget > 0 && !overBudget && monthCost >= effectiveBudget * 0.8
  // token 预算：项目/全局同口径（价格独立护栏，兜底 cost=$0 的自建网关）。
  const effectiveTokenBudget = resolveEffectiveTokenBudget(
    projectId,
    tokenBudget,
    globalTokenBudget,
  )
  const overTokenBudget = effectiveTokenBudget > 0 && monthTokens > effectiveTokenBudget
  // H2：价格未知的调用按 $0 计入，显式提示成本可能低估。
  const unknownCostTotal = summary?.totals.unknownCostCalls ?? 0
  // L2：无时间戳调用归入「未知」月份，不参与本月预算比较——同样需要提示。
  const unknownMonth = summary?.byMonth.find((m) => m.month === '未知')
  const unassigned = summary?.unassigned

  return (
    <div className={section} data-testid="usage-panel">
      <h2 className={sectionTitle}>用量与成本</h2>
      <div className={hint}>
        统计本项目全部会话（含回收站内已删除会话）的 LLM 调用；成本按 provider 价目估算
        {summary ? `（价目版本 ${summary.priceCatalogVersion}，实际费用以账单为准）` : ''}。
        成本是账本：会话彻底删除后已发生花费仍计入。
      </div>
      {projectId ? (
        <label className={field}>
          <span>月度成本预算（USD，0 = 不限制）</span>
          <input
            className={fieldInput}
            type="number"
            min={0}
            step="0.5"
            value={budget}
            onChange={(e) => onBudgetChange(Math.max(0, Number(e.target.value)))}
          />
        </label>
      ) : (
        <label className={field}>
          <span>全局月度预算（USD，0 = 不限制；所有项目 + 未归属调用聚合，兜底护栏）</span>
          <input
            className={fieldInput}
            type="number"
            min={0}
            step="0.5"
            value={globalBudget ?? 0}
            onChange={(e) => onGlobalBudgetChange?.(Math.max(0, Number(e.target.value)))}
            data-testid="usage-global-budget"
          />
        </label>
      )}
      {projectId ? (
        <label className={field}>
          <span>月度 token 预算（input+output+cacheRead，0 = 不限制；兜底价格未知的调用）</span>
          <input
            className={fieldInput}
            type="number"
            min={0}
            step="1000"
            value={tokenBudget ?? 0}
            onChange={(e) => onTokenBudgetChange?.(Math.max(0, Number(e.target.value)))}
            data-testid="usage-token-budget"
          />
        </label>
      ) : (
        <label className={field}>
          <span>全局月度 token 预算（input+output+cacheRead，0 = 不限制）</span>
          <input
            className={fieldInput}
            type="number"
            min={0}
            step="1000"
            value={globalTokenBudget ?? 0}
            onChange={(e) => onGlobalTokenBudgetChange?.(Math.max(0, Number(e.target.value)))}
            data-testid="usage-global-token-budget"
          />
        </label>
      )}
      {projectId && (globalBudget ?? 0) > 0 && (
        <div className={hint}>
          另有全局预算 ${(globalBudget ?? 0).toFixed(2)} 兜底（所有项目聚合）。
        </div>
      )}
      {effectiveBudget > 0 && (
        <label className={field}>
          <span>超支动作</span>
          <select
            className={fieldInput}
            value={budgetAction === 'pause' ? 'pause' : 'warn'}
            onChange={(e) => onBudgetActionChange(e.target.value === 'pause' ? 'pause' : 'warn')}
            data-testid="usage-budget-action"
          >
            <option value="warn">仅告警（顶栏徽标变红，对话继续）</option>
            <option value="pause">暂停对话（新一轮回复前暂停，点「恢复」继续）</option>
          </select>
        </label>
      )}
      {overBudget && (
        <div className={budgetWarn} data-testid="usage-budget-warning">
          ⚠ 本月成本 ${monthCost.toFixed(2)} 已超过{projectId ? '项目' : '全局'}预算 $
          {effectiveBudget.toFixed(2)}
        </div>
      )}
      {!overBudget && nearBudget && effectiveBudget > 0 && (
        <div className={budgetWarn} data-testid="usage-budget-near">
          ▲ 本月成本已达预算的 80%（${monthCost.toFixed(2)} / ${effectiveBudget.toFixed(2)}）
        </div>
      )}
      {overTokenBudget && (
        <div className={budgetWarn} data-testid="usage-token-budget-warning">
          ⚠ 本月 token 用量 {fmtTokens(monthTokens)} 已超过{projectId ? '项目' : '全局'} token 预算{' '}
          {fmtTokens(effectiveTokenBudget)}
          {budgetAction !== 'pause' ? '（当前为「仅告警」，对话继续）' : ''}
        </div>
      )}
      {effectiveTokenBudget > 0 && budgetAction !== 'pause' && (
        <div className={hint} data-testid="usage-token-budget-hint">
          token 预算在「仅告警」模式下超支仅提示、不暂停；设为「暂停对话」才会在超支时硬性拦截。
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
      {!projectId && unassigned && unassigned.calls > 0 && (
        <div className={rowGrid} data-testid="usage-unassigned">
          <span title="未归属任何项目的调用（CLI 未绑定会话/孤儿会话），不计入任何项目预算">
            ⚠ 未归属项目
          </span>
          <span>{unassigned.calls}</span>
          <span>
            {fmtTokens(unassigned.inputTokens + unassigned.outputTokens + unassigned.cacheRead)}
          </span>
          <span>{fmtCost(unassigned.cost)}</span>
        </div>
      )}
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
