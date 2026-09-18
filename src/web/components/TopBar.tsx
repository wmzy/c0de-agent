import { css } from '@linaria/core'
import { TypedLink, useMatched } from '@native-router/react'
import { useQuery } from '@tanstack/react-query'
import { CommitButton } from '@/components/CommitButton.js'
import { Logo } from '@/components/Logo.js'
import { ProjectIndicator } from '@/components/ProjectIndicator.js'
import type { AppPaths } from '@/routes.js'
import { configAPI } from '@/services/config.js'
import { usageAPI } from '@/services/usage.js'
import {
  monthTokenSum,
  resolveEffectiveBudget,
  resolveEffectiveTokenBudget,
} from '@/utils/usage.js'

const bar = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 44px;
  padding: 0 12px;
  border-bottom: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg-subtle);
  flex-shrink: 0;
`

const brandGroup = css`
  display: flex;
  align-items: center;
  gap: 8px;
  /* 允许收缩给右侧导航让位（窄屏防横向溢出）；项目名随之省略号截断 */
  min-width: 0;
`

const brand = css`
  display: inline-flex;
  align-items: center;
  color: var(--haze-color-text);
  text-decoration: none;
  min-height: auto;
  flex-shrink: 0;
`

const nav = css`
  display: flex;
  align-items: center;
  gap: 4px;
  /* 导航不压缩：窄屏溢出压力由左侧品牌区（项目名截断）吸收 */
  flex-shrink: 0;
`

const link = css`
  display: inline-flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 13px;
  color: var(--haze-color-text-secondary);
  text-decoration: none;
  min-height: auto;
  min-width: auto;
  cursor: pointer;
  &:hover {
    background: var(--haze-color-bg);
    color: var(--haze-color-text);
  }
`

const activeLink = css`
  background: var(--haze-color-bg);
  color: var(--haze-color-primary);
  font-weight: 600;
`

/** M5：顶栏月成本徽标——成本护栏从设置页深处提升到全局可见。 */
const costBadge = css`
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--haze-color-text-secondary);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  text-decoration: none;
  white-space: nowrap;
  &:hover {
    border-color: var(--haze-color-text-secondary);
  }
`

const costNear = css`
  color: var(--haze-color-warning);
  border-color: color-mix(in srgb, var(--haze-color-warning) 55%, transparent);
`

const costOver = css`
  color: var(--haze-color-danger);
  border-color: color-mix(in srgb, var(--haze-color-danger) 55%, transparent);
  font-weight: 600;
`

/** 本月成本徽标：显示当月估算成本，按预算阈值变色（≥80% 警示、超预算告警）。
 *  点击跳转设置页「用量与成本」面板。P1：按当前项目口径统计——
 *  汇总与预算均取项目合并配置 + 项目聚合成本，项目间互不干扰。
 *  无项目上下文时退化为全局口径（'/settings' 根路由）。 */
function MonthCostBadge({ projectId }: { projectId?: string }) {
  // 直接走共享 query 缓存（与 Settings 同一 queryKey，零额外请求），
  // 避免 TopBar 依赖 ConfigProvider 的渲染层级。
  const { data: configResp } = useQuery({
    queryKey: ['config', projectId ?? 'server'],
    queryFn: () => configAPI.get(projectId),
    staleTime: 60_000,
  })
  const budget = configResp?.config?.usage?.monthlyBudgetUsd ?? 0
  const globalBudget = configResp?.config?.usage?.globalMonthlyBudgetUsd ?? 0
  const tokenBudget = configResp?.config?.usage?.monthlyTokenBudget ?? 0
  const globalTokenBudget = configResp?.config?.usage?.globalMonthlyTokenBudget ?? 0
  const { data: summary } = useQuery({
    queryKey: ['usage', 'summary', projectId ?? 'all'],
    queryFn: () => usageAPI.summary(projectId),
    staleTime: 60_000,
    refetchInterval: 120_000,
  })
  // P1-4：本月口径由服务端下发（服务端时区），与预算暂停判定同源。
  // P1-3：无项目上下文时按全局预算比较（项目视图仍按项目预算）。
  const monthEntry = summary?.currentMonth
  const cost = monthEntry?.cost ?? 0
  const effectiveBudget = resolveEffectiveBudget(projectId, budget, globalBudget)
  const overBudget = effectiveBudget > 0 && cost > effectiveBudget
  const nearBudget = effectiveBudget > 0 && !overBudget && cost >= effectiveBudget * 0.8
  // token 口径（input+output+cacheRead，与预算暂停判定同源）——价格未知的自建网关
  // cost 恒 $0，金额徽标显示 $0 时 token 超支仍应有告警。
  const monthTokens = monthTokenSum(monthEntry)
  const effectiveTokenBudget = resolveEffectiveTokenBudget(
    projectId,
    tokenBudget,
    globalTokenBudget,
  )
  const overTokenBudget = effectiveTokenBudget > 0 && monthTokens > effectiveTokenBudget
  const overAny = overBudget || overTokenBudget
  const unknown = monthEntry?.unknownCostCalls ?? 0
  const tip =
    `本月估算成本 $${cost.toFixed(2)}` +
    (effectiveBudget > 0
      ? `（${projectId ? '项目' : '全局'}预算 $${effectiveBudget.toFixed(2)}${overBudget ? '，已超支' : ''}）`
      : '') +
    (overTokenBudget
      ? `；token 用量 ${monthTokens.toLocaleString()} 已超 ${effectiveTokenBudget.toLocaleString()}`
      : '') +
    (unknown > 0 ? `；${unknown} 次调用价格未知按 $0 计` : '') +
    '。点击前往设置查看用量与成本。'
  const badgeClass = `${costBadge}${overAny ? ` ${costOver}` : nearBudget ? ` ${costNear}` : ''}`
  const badgeText = `${overAny ? '⚠ ' : nearBudget ? '▲ ' : ''}本月 $${cost.toFixed(2)}`
  return projectId ? (
    <TypedLink<AppPaths>
      to="/projects/:projectId/settings"
      params={{ projectId }}
      className={badgeClass}
      title={tip}
      data-testid="month-cost-badge"
    >
      {badgeText}
    </TypedLink>
  ) : (
    <TypedLink<AppPaths>
      to="/settings"
      className={badgeClass}
      title={tip}
      data-testid="month-cost-badge"
    >
      {badgeText}
    </TypedLink>
  )
}

/** 全局顶部导航栏：品牌标识 + 主界面/看板/设置入口。 */
export function TopBar() {
  // notFound 视图提交在匹配链之外（无 MatchedContext），useMatched 返回 undefined；
  // 404 页仍需渲染 TopBar，故按缺省路径处理（无 projectId、无高亮）。
  const matchedCtx = useMatched()
  const routePath = matchedCtx?.matched[matchedCtx.matched.length - 1]?.route.path ?? ''
  const projectId = matchedCtx?.params.projectId
  const isSettings = routePath === '/settings' || routePath === '/projects/:projectId/settings'
  const isKanban = routePath === '/projects/:projectId/kanban'
  // 会话入口：项目上下文跳当前项目，否则回根路径（由 RootRedirect 解析当前项目）。
  const sessionsActive = !isSettings && !isKanban

  return (
    <header className={bar} data-testid="topbar">
      <div className={brandGroup}>
        <TypedLink<AppPaths> to="/" className={brand} title="c0de-agent 首页">
          {/* 仅显示品牌 mark：字标与右侧项目切换器的项目名（可能恰为 c0de-agent）
              同字样相邻会造成品牌/项目身份混淆，品牌名由 Logo 内 sr-only 文本保留 */}
          <Logo wordmark={false} />
        </TypedLink>
        {projectId && (
          <ProjectIndicator
            projectId={projectId}
            variant="inline"
            actions={<CommitButton projectId={projectId} />}
          />
        )}
      </div>
      <nav className={nav}>
        <MonthCostBadge projectId={projectId} />
        {projectId ? (
          <TypedLink<AppPaths>
            to="/projects/:projectId"
            params={{ projectId }}
            className={`${link} ${sessionsActive ? activeLink : ''}`}
            data-active={sessionsActive || undefined}
          >
            会话
          </TypedLink>
        ) : (
          <TypedLink<AppPaths>
            to="/"
            className={`${link} ${sessionsActive ? activeLink : ''}`}
            data-active={sessionsActive || undefined}
          >
            会话
          </TypedLink>
        )}
        {projectId ? (
          <TypedLink<AppPaths>
            to="/projects/:projectId/kanban"
            params={{ projectId }}
            className={`${link} ${isKanban ? activeLink : ''}`}
            data-active={isKanban || undefined}
            data-testid="nav-kanban"
            title="项目级任务看板（与会话内的 agent 待办相互独立）"
          >
            项目看板
          </TypedLink>
        ) : (
          <TypedLink<AppPaths>
            to="/"
            className={`${link} ${isKanban ? activeLink : ''}`}
            data-active={isKanban || undefined}
            data-testid="nav-kanban"
            title="项目级任务看板（与会话内的 agent 待办相互独立）"
          >
            项目看板
          </TypedLink>
        )}
        {projectId ? (
          <TypedLink<AppPaths>
            to="/projects/:projectId/settings"
            params={{ projectId }}
            className={`${link} ${isSettings ? activeLink : ''}`}
            data-active={isSettings || undefined}
          >
            设置
          </TypedLink>
        ) : (
          <TypedLink<AppPaths>
            to="/settings"
            className={`${link} ${isSettings ? activeLink : ''}`}
            data-active={isSettings || undefined}
          >
            设置
          </TypedLink>
        )}
      </nav>
    </header>
  )
}
