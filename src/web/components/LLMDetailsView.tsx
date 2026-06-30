import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { sessionAPI } from '../services/session.js'
import { LLMDetailPanel } from './LLMDetail.js'

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

const list = css`
  padding: 4px 12px 8px;
  max-height: 40vh;
  overflow: auto;
`

const status = css`
  color: var(--text-secondary);
`

const errStatus = css`
  color: var(--danger, #e5484d);
`

/**
 * 会话级 LLM 调用详情视图：拉取 `/llm-details` 并按需展开，展示每次 LLM 调用的
 * 完整上下文（system prompt / messages / tools / response）。
 */
export function LLMDetailsView({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const { data, isLoading, error } = useQuery({
    queryKey: ['session', sessionId, 'llm-details'],
    queryFn: () => sessionAPI.llmDetails(sessionId),
    staleTime: 10_000,
  })

  const details = data ?? []

  return (
    <div className={wrap} data-testid="llm-details-view">
      <button
        className={toggle}
        onClick={() => setOpen((v) => !v)}
        type="button"
        data-testid="llm-details-toggle"
        aria-expanded={open}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>调用详情 ({details.length})</span>
      </button>
      {open && (
        <div className={list} data-testid="llm-details-list">
          {isLoading && <span className={status}>加载中…</span>}
          {!isLoading && error && <span className={errStatus}>加载失败</span>}
          {!isLoading && !error && details.length === 0 && (
            <span className={status}>暂无 LLM 调用记录</span>
          )}
          {!isLoading &&
            !error &&
            [...details].reverse().map((d, i) => {
              const n = details.length - i
              return (
                <div key={d.id}>
                  <div data-testid="llm-detail-header">
                    调用 #{n} · {d.model} · {new Date(d.timestamp).toLocaleString()}
                  </div>
                  <LLMDetailPanel detail={d} />
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}
