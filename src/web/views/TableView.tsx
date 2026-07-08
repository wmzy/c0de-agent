import { css } from '@linaria/core'
import { Fragment, useMemo, useState } from 'react'
import type { TimelineRow } from '../components/session/utils/timeline.js'
import { formatCost, formatLatency, formatTimestamp, formatTokenCount } from '../utils/format.js'

const wrap = css`
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`

const filterBar = css`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  font-size: 12px;
`

const filterInput = css`
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 8px;
  color: var(--text);
  font-size: 12px;
  min-width: 0;

  &:focus {
    outline: none;
    border-color: var(--primary);
  }
`

const select = filterInput

const scroll = css`
  flex: 1;
  overflow: auto;
`

const table = css`
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;

  th,
  td {
    padding: 4px 8px;
    text-align: left;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }

  th {
    position: sticky;
    top: 0;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-weight: 500;
    z-index: 1;
  }

  tbody tr {
    cursor: pointer;

    &:hover {
      background: var(--bg-secondary);
    }
  }
`

const summaryCell = css`
  white-space: pre-wrap !important;
  word-break: break-word;
  max-width: 320px;
`

const dim = css`
  color: var(--text-secondary);
`

const typeTag = css`
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  background: var(--bg);
  border: 1px solid var(--border);
`

const jsonRow = css`
  td {
    background: var(--bg);
    white-space: normal !important;
  }

  pre {
    margin: 0;
    padding: 8px;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 11px;
    max-height: 320px;
    overflow: auto;
  }
`

const tdCenter = css`
  text-align: center;
`

/** 行类型标签。 */
function typeLabel(row: TimelineRow): string {
  switch (row.kind) {
    case 'message':
      return '消息'
    case 'call':
      return '调用'
    case 'segment':
      return '段'
  }
}

/** 行角色（仅消息有）。 */
function rowRole(row: TimelineRow): string {
  if (row.kind === 'message') return row.message.role
  return ''
}

/** 消息内出现的工具名（tool_call / tool_result）。 */
function rowToolName(row: TimelineRow): string {
  if (row.kind !== 'message') return ''
  const part = row.message.content.find((p) => p._tag === 'tool_call' || p._tag === 'tool_result')
  if (!part) return ''
  return part._tag === 'tool_call' ? part.tool : part.tool
}

/** 调用所属段的 model（调用行展示）。 */
function rowModel(row: TimelineRow): string {
  if (row.kind === 'call' || row.kind === 'segment') return row.segment.model
  return ''
}

function rowTime(row: TimelineRow): string {
  return formatTimestamp(row.ts)
}

function rowTokens(row: TimelineRow): string {
  if (row.kind !== 'call') return ''
  return `${formatTokenCount(row.call.usage.input)}→${formatTokenCount(row.call.usage.output)}`
}

function rowCost(row: TimelineRow): string {
  if (row.kind !== 'call') return ''
  return formatCost(row.call.cost)
}

function rowLatency(row: TimelineRow): string {
  if (row.kind !== 'call') return ''
  return formatLatency(row.call.latency.total)
}

function rowSummary(row: TimelineRow): string {
  switch (row.kind) {
    case 'message': {
      const m = row.message
      const textPart = m.content.find((p) => p._tag === 'text')
      if (textPart && textPart._tag === 'text') return textPart.text.slice(0, 120)
      const tool = rowToolName(row)
      if (tool) return `🔧 ${tool}`
      return '(空内容)'
    }
    case 'call': {
      const t = row.call.responseText.slice(0, 120)
      return t || '(无文本)'
    }
    case 'segment':
      return `${row.segment.trigger} · ${row.segment.tools.length} 工具`
  }
}

/** 行的原始 JSON（展开用）。 */
function rowJSON(row: TimelineRow): string {
  switch (row.kind) {
    case 'message':
      return JSON.stringify(row.message, null, 2)
    case 'call':
      return JSON.stringify(row.call, null, 2)
    case 'segment':
      return JSON.stringify(row.segment, null, 2)
  }
}

/** 筛选后的可搜索文本（小写）。 */
function rowSearchText(row: TimelineRow): string {
  const parts = [typeLabel(row), rowRole(row), rowToolName(row), rowModel(row), rowSummary(row)]
  return parts.join(' ').toLowerCase()
}

/**
 * 表格视图：时间线所有行平铺为表格，支持文本搜索 + 类型/角色/工具筛选，
 * 点击行展开原始 JSON。
 */
export function TableView({ rows }: { rows: TimelineRow[] }) {
  const [q, setQ] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | TimelineRow['kind']>('all')
  const [roleFilter, setRoleFilter] = useState('all')
  const [toolFilter, setToolFilter] = useState('all')
  const [openIdx, setOpenIdx] = useState<number | null>(null)

  // 工具名候选（来自所有消息的工具调用）
  const toolNames = useMemo(() => {
    const set = new Set<string>()
    for (const row of rows) {
      const t = rowToolName(row)
      if (t) set.add(t)
    }
    return [...set].sort()
  }, [rows])

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return rows.filter((row) => {
      if (typeFilter !== 'all' && row.kind !== typeFilter) return false
      if (roleFilter !== 'all' && rowRole(row) !== roleFilter) return false
      if (toolFilter !== 'all' && rowToolName(row) !== toolFilter) return false
      if (ql && !rowSearchText(row).includes(ql)) return false
      return true
    })
  }, [rows, q, typeFilter, roleFilter, toolFilter])

  return (
    <div className={wrap} data-testid="table-view">
      <div className={filterBar}>
        <input
          className={filterInput}
          placeholder="搜索…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="table-search"
        />
        <select
          className={select}
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as 'all' | TimelineRow['kind'])}
          aria-label="类型筛选"
          data-testid="table-filter-type"
        >
          <option value="all">全部类型</option>
          <option value="message">消息</option>
          <option value="call">调用</option>
          <option value="segment">段</option>
        </select>
        <select
          className={select}
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          aria-label="角色筛选"
          data-testid="table-filter-role"
        >
          <option value="all">全部角色</option>
          <option value="user">user</option>
          <option value="assistant">assistant</option>
          <option value="tool">tool</option>
        </select>
        <select
          className={select}
          value={toolFilter}
          onChange={(e) => setToolFilter(e.target.value)}
          aria-label="工具筛选"
        >
          <option value="all">全部工具</option>
          {toolNames.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span className={dim}>
          {filtered.length}/{rows.length}
        </span>
      </div>
      <div className={scroll}>
        <table className={table}>
          <thead>
            <tr>
              <th>#</th>
              <th>类型</th>
              <th>角色/工具</th>
              <th>时间</th>
              <th>tokens</th>
              <th>延迟</th>
              <th>cost</th>
              <th>摘要</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const idx = rows.indexOf(row)
              const open = openIdx === idx
              const tool = rowToolName(row)
              return (
                <Fragment key={`g-${idx}`}>
                  <tr onClick={() => setOpenIdx(open ? null : idx)} data-testid="table-row">
                    <td className={dim}>{idx}</td>
                    <td>
                      <span className={typeTag}>{typeLabel(row)}</span>
                    </td>
                    <td>{tool || rowRole(row) || rowModel(row) || '—'}</td>
                    <td className={dim}>{rowTime(row)}</td>
                    <td>{rowTokens(row) || '—'}</td>
                    <td>{rowLatency(row) || '—'}</td>
                    <td>{rowCost(row) || '—'}</td>
                    <td className={summaryCell}>{rowSummary(row)}</td>
                  </tr>
                  {open && (
                    <tr className={jsonRow} data-testid="table-row-json">
                      <td colSpan={8}>
                        <pre>{rowJSON(row)}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className={tdCenter}>
                  <span className={dim}>无匹配项</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
