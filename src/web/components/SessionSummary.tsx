import { css } from '@linaria/core'
import type { LLMDetail } from '@shared/types/agent.js'
import type { Message, Session } from '@shared/types/message.js'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { useMessages } from '../hooks/useSession.js'
import { sessionAPI } from '../services/session.js'

const wrap = css`
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  font-size: 12px;
`

const toggle = css`
  display: flex;
  width: 100%;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  text-align: left;

  &:hover {
    color: var(--text);
  }
`

const grid = css`
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 16px;
  padding: 4px 16px 10px;
  max-height: 40vh;
  overflow: auto;
`

const label = css`
  color: var(--text-secondary);
`

const value = css`
  color: var(--text);
  font-variant-numeric: tabular-nums;
  word-break: break-word;
`

const sessionTitle = css`
  grid-column: 1 / -1;
  font-weight: 600;
  color: var(--text);
  font-size: 13px;
  margin-bottom: 2px;
`

const status = css`
  grid-column: 1 / -1;
  color: var(--text-secondary);
`

/** 千分位格式化（与 opencode 一致：1,000,000 / 302,253）。 */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/** 日期时间格式化（与样例一致：2026年6月25日 17:35）。 */
function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 美元成本格式化（与样例一致：US$0.00）。 */
function formatCostUSD(cost: number): string {
  return `US$${cost.toFixed(2)}`
}

type Stats = {
  title: string
  messageCount: number
  userMessages: number
  assistantMessages: number
  provider?: string
  model?: string
  contextWindow?: number
  totalTokens: number
  usagePercent?: number
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cost: number
  createdAt?: number
  updatedAt?: number
}

/** 聚合会话、消息、LLM 调用详情为总结统计。 */
function computeStats(
  session: Session | undefined,
  messages: Message[] | undefined,
  details: LLMDetail[],
): Stats {
  const msgs = messages ?? []
  const userMessages = msgs.filter((m) => m.role === 'user').length
  const assistantMessages = msgs.filter((m) => m.role === 'assistant').length
  const inputTokens = details.reduce((s, d) => s + d.usage.input, 0)
  const outputTokens = details.reduce((s, d) => s + d.usage.output, 0)
  const cacheRead = details.reduce((s, d) => s + (d.usage.cacheRead ?? 0), 0)
  const cost = details.reduce((s, d) => s + d.cost, 0)
  // 总 token = 输入 + 输出 + 缓存读（推理/缓存写当前未采集，计 0）。
  const totalTokens = inputTokens + outputTokens + cacheRead
  const latest = details[details.length - 1]
  const contextWindow = latest?.contextWindow
  const usagePercent = contextWindow
    ? Math.min(100, Math.round((totalTokens / contextWindow) * 100))
    : undefined
  return {
    title: session?.title ?? '（未命名会话）',
    messageCount: msgs.length,
    userMessages,
    assistantMessages,
    provider: latest?.provider,
    model: latest?.model,
    contextWindow,
    totalTokens,
    usagePercent,
    inputTokens,
    outputTokens,
    cacheRead,
    cost,
    createdAt: session?.createdAt,
    updatedAt: session?.updatedAt,
  }
}

function StatRow({ label: lab, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className={label}>{lab}</span>
      <span className={value}>{children}</span>
    </>
  )
}

/**
 * 会话级总结信息面板：聚合 session / messages / llm-details，展示与会话、
 * token 用量、成本、时间相关的统计，布局对齐 opencode 的统计面板。
 */
export function SessionSummary({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const { data: session } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => sessionAPI.get(sessionId),
    staleTime: 10_000,
  })
  const { data: messages } = useMessages(sessionId)
  const { data: details, isLoading } = useQuery({
    queryKey: ['session', sessionId, 'llm-details'],
    queryFn: () => sessionAPI.llmDetails(sessionId),
    staleTime: 10_000,
  })

  const stats = useMemo(
    () => computeStats(session, messages, details ?? []),
    [session, messages, details],
  )

  return (
    <div className={wrap} data-testid="session-summary">
      <button
        className={toggle}
        onClick={() => setOpen((v) => !v)}
        type="button"
        data-testid="session-summary-toggle"
        aria-expanded={open}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>会话信息</span>
      </button>
      {open && (
        <div className={grid} data-testid="session-summary-grid">
          {isLoading ? (
            <span className={status}>加载中…</span>
          ) : (
            <>
              <span className={sessionTitle}>{stats.title}</span>
              <StatRow label="消息数">{formatNumber(stats.messageCount)}</StatRow>
              <StatRow label="提供商">{stats.provider ?? '—'}</StatRow>
              <StatRow label="模型">{stats.model ?? '—'}</StatRow>
              <StatRow label="上下文限制">
                {stats.contextWindow ? formatNumber(stats.contextWindow) : '—'}
              </StatRow>
              <StatRow label="总 token">{formatNumber(stats.totalTokens)}</StatRow>
              <StatRow label="使用率">
                {stats.usagePercent != null ? `${stats.usagePercent}%` : '—'}
              </StatRow>
              <StatRow label="输入 token">{formatNumber(stats.inputTokens)}</StatRow>
              <StatRow label="输出 token">{formatNumber(stats.outputTokens)}</StatRow>
              {/* 推理 token / 缓存写当前未在 provider 层采集，诚实显示 0 */}
              <StatRow label="推理 token">0</StatRow>
              <StatRow label="缓存 token（读/写）">{formatNumber(stats.cacheRead)} / 0</StatRow>
              <StatRow label="用户消息">{formatNumber(stats.userMessages)}</StatRow>
              <StatRow label="助手消息">{formatNumber(stats.assistantMessages)}</StatRow>
              <StatRow label="总成本">{formatCostUSD(stats.cost)}</StatRow>
              <StatRow label="创建时间">
                {stats.createdAt ? formatDateTime(stats.createdAt) : '—'}
              </StatRow>
              <StatRow label="最后活动">
                {stats.updatedAt ? formatDateTime(stats.updatedAt) : '—'}
              </StatRow>
            </>
          )}
        </div>
      )}
    </div>
  )
}
