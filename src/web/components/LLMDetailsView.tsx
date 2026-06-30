import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { sessionAPI } from '../services/session.js'
import { CallRow, SegmentHeader } from './LLMDetail.js'

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
 * 会话级 LLM 调用分段视图：拉取 `/llm-details`（返回 LLMSegment[]）并按需展开，
 * 按段折叠渲染——段首快照（system prompt / tools）存一次，段内 calls 轻量展示。
 */
export function LLMDetailsView({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const { data, isLoading, error } = useQuery({
    queryKey: ['session', sessionId, 'llm-details'],
    queryFn: () => sessionAPI.llmDetails(sessionId),
    staleTime: 10_000,
  })

  const segments = data ?? []
  const totalCalls = segments.reduce((sum, seg) => sum + seg.calls.length, 0)

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
        <span>调用详情 ({totalCalls})</span>
      </button>
      {open && (
        <div className={list} data-testid="llm-details-list">
          {isLoading && <span className={status}>加载中…</span>}
          {!isLoading && error && <span className={errStatus}>加载失败</span>}
          {!isLoading && !error && totalCalls === 0 && (
            <span className={status}>暂无 LLM 调用记录</span>
          )}
          {!isLoading &&
            !error &&
            segments.map((seg) => (
              <div key={seg.id}>
                <SegmentHeader segment={seg} />
                {[...seg.calls].reverse().map((call, i) => (
                  <CallRow key={call.id} call={call} index={seg.calls.length - i} />
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
