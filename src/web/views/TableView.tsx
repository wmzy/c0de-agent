import { css } from '@linaria/core'
import { Fragment, useMemo, useState } from 'react'
import { SyncedInput, SyncedSelect } from '@/components/SyncedControls.js'
import type { TimelineRow } from '@/components/session/utils/timeline.js'
import { formatCost, formatLatency, formatTimestamp, formatTokenCount } from '@/utils/format.js'

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
  border-bottom: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg-subtle);
  font-size: 12px;
`

const filterInput = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 3px 8px;
  color: var(--haze-color-text);
  font-size: 12px;
  min-width: 0;
  /* 自适应内容宽度：haze SelectCore 的 width:100% 会让每个筛选项撑满整行，
   * 4 个控件竖着排满一屏（实测每个 1106px），工具条形同失效。见 tokens.compactSelect。 */
  width: auto;
  max-width: 240px;
  text-overflow: ellipsis;

  &:focus {
    outline: none;
    border-color: var(--haze-color-primary);
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
    border-bottom: 1px solid var(--haze-color-border);
    white-space: nowrap;
  }

  th {
    position: sticky;
    top: 0;
    background: var(--haze-color-bg-subtle);
    color: var(--haze-color-text-secondary);
    font-weight: 500;
    z-index: 1;
  }

  tbody tr {
    cursor: pointer;

    &:hover {
      background: var(--haze-color-bg-subtle);
    }

    /* 焦点环用 :focus-visible（与 global.ts / KanbanView 同一口径）：键盘 Tab
     * 过去才显示，鼠标点击不显示。outline-offset:-1px 画在单元格分隔线内侧，
     * 不会被相邻 td 的背景盖住。 */
    &:focus-visible {
      outline: 2px solid var(--haze-color-primary);
      outline-offset: -1px;
    }
  }
`

const summaryCell = css`
  white-space: pre-wrap !important;
  word-break: break-word;
  max-width: 320px;
`

const dim = css`
  color: var(--haze-color-text-secondary);
`

const typeTag = css`
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
`

const jsonRow = css`
  td {
    background: var(--haze-color-bg);
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

/**
 * 消息内出现的全部工具名（tool_call / tool_result，去重保序）。
 *
 * 此前只 `.find()` 首个工具 —— 一条 assistant 消息可以并行发起多个工具调用
 * （normalizeParts 把每个 tool_call 都保留为独立 part），于是「角色/工具」列、
 * 「工具筛选」下拉候选集与文本搜索都只认第一个工具：选第二个工具名筛选得到
 * 「无匹配项」，用户据此判断「这个会话从没跑过 bash」，而展开行内原始 JSON
 * 就能看到那次调用确实存在 —— 排障结论被 UI 直接带反。
 */
function rowToolNames(row: TimelineRow): string[] {
  if (row.kind !== 'message') return []
  const names: string[] = []
  for (const p of row.message.content) {
    if (p._tag !== 'tool_call' && p._tag !== 'tool_result') continue
    if (!names.includes(p.tool)) names.push(p.tool)
  }
  return names
}

/** 首个工具名（摘要列展示用）。 */
function rowToolName(row: TimelineRow): string {
  return rowToolNames(row)[0] ?? ''
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
  // H2：价格未知（cost=null）按 $0 展示并附注。
  if (row.call.cost == null) return `${formatCost(0)}（未估价）`
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
  const parts = [typeLabel(row), rowRole(row), ...rowToolNames(row), rowModel(row), rowSummary(row)]
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

  // 工具名候选（来自所有消息的全部工具调用，不只是每条消息的首个）
  const toolNames = useMemo(() => {
    const set = new Set<string>()
    for (const row of rows) {
      for (const t of rowToolNames(row)) set.add(t)
    }
    return [...set].sort()
  }, [rows])

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return rows.filter((row) => {
      if (typeFilter !== 'all' && row.kind !== typeFilter) return false
      if (roleFilter !== 'all' && rowRole(row) !== roleFilter) return false
      if (toolFilter !== 'all' && !rowToolNames(row).includes(toolFilter)) return false
      if (ql && !rowSearchText(row).includes(ql)) return false
      return true
    })
  }, [rows, q, typeFilter, roleFilter, toolFilter])

  return (
    <div className={wrap} data-testid="table-view">
      <div className={filterBar}>
        <SyncedInput
          className={filterInput}
          placeholder="搜索…"
          /* 显式名称而非只靠 placeholder：placeholder 只是视觉提示（HTML-AAM 会在名称
           * 为空时拿它兜底，但那是脆弱的名字来源）。与相邻的三个筛选下拉并列，
           * 读屏用户需要一个稳定字段名来区分这是搜什么。 */
          aria-label="搜索当前会话的消息与调用"
          value={q}
          onChange={(v) => setQ(v)}
          data-testid="table-search"
        />
        <SyncedSelect
          className={select}
          value={typeFilter}
          onValuesChange={(v) => setTypeFilter(v as 'all' | TimelineRow['kind'])}
          aria-label="类型筛选"
          data-testid="table-filter-type"
        >
          <option value="all">全部类型</option>
          <option value="message">消息</option>
          <option value="call">调用</option>
          <option value="segment">段</option>
        </SyncedSelect>
        <SyncedSelect
          className={select}
          value={roleFilter}
          onValuesChange={(v) => setRoleFilter(v as string)}
          aria-label="角色筛选"
          data-testid="table-filter-role"
        >
          <option value="all">全部角色</option>
          <option value="user">user</option>
          <option value="assistant">assistant</option>
          <option value="tool">tool</option>
        </SyncedSelect>
        <SyncedSelect
          className={select}
          value={toolFilter}
          onValuesChange={(v) => setToolFilter(v as string)}
          aria-label="工具筛选"
          data-testid="table-filter-tool"
        >
          <option value="all">全部工具</option>
          {toolNames.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </SyncedSelect>
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
              // 全部工具名（不只首个）：列里逐个列出，否则并行的第二个工具
              // 调用在这个视图里完全不可见
              const tools = rowToolNames(row)
              // 展开交互此前只挂在裸 <tr onClick> 上：没有 tabIndex、没有键盘处理，
              // 键盘用户 Tab 走遍筛选条与计数后直接跳出表格（实测表格视图内 Tab
              // 序列：筛选控件 → 计数 → Todo 面板，tbody 行一个都碰不到），
              // 「查看原始 JSON」这条排障入口对键盘/读屏用户等于不存在。
              // tabIndex 让行进入 Tab 序列，Enter/Space 与点击同效；行本身已是
              // row 角色（ARIA 原生支持 aria-expanded），不额外加 role，
              // 行的可访问名由各单元格文本自然拼出——aria-label 反而会盖掉
              // 「摘要」列内容，读屏就听不到这一行到底写了什么。
              const toggle = () => setOpenIdx(open ? null : idx)
              return (
                <Fragment key={`g-${idx}`}>
                  <tr
                    onClick={toggle}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        // 空格默认会滚动页面；行内是唯一动作，必须拦下
                        e.preventDefault()
                        toggle()
                      }
                    }}
                    tabIndex={0}
                    aria-expanded={open}
                    data-testid="table-row"
                  >
                    <td className={dim}>{idx}</td>
                    <td>
                      <span className={typeTag}>{typeLabel(row)}</span>
                    </td>
                    <td>{tools.join(' ') || rowRole(row) || rowModel(row) || '—'}</td>
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
