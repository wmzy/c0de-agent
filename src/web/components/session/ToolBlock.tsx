import { css } from '@linaria/core'
import { useEffect, useState } from 'react'
import { BashToolView } from './tools/BashToolView.js'
import { EditToolView } from './tools/EditToolView.js'
import { FallbackToolView } from './tools/FallbackToolView.js'
import { GlobToolView } from './tools/GlobToolView.js'
import { GrepToolView } from './tools/GrepToolView.js'
import { ReadToolView } from './tools/ReadToolView.js'
import { WriteToolView } from './tools/WriteToolView.js'
import type { RenderBlock } from './utils/normalizeParts.js'
import { toolSummary } from './utils/toolSummary.js'

type ToolRenderBlock = Extract<RenderBlock, { type: 'tool' }>

const STATUS_ICON: Record<ToolRenderBlock['status'], string> = {
  running: '⏳',
  completed: '✓',
  error: '✗',
  paused: '🔒',
}

const wrap = css`
  display: flex;
  flex-direction: column;
`

/**
 * 可折叠 header：状态 icon + 摘要 + 展开箭头。
 * 点击切换展开态；运行中默认展开，完成/出错后自动收起一次。
 */
const header = css`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  width: 100%;
  text-align: left;
`

const icon = css`
  width: 14px;
  flex-shrink: 0;
  text-align: center;
`

const summary = css`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
`

const arrow = css`
  flex-shrink: 0;
  color: var(--text-secondary);
`

const body = css`
  margin-top: 2px;
`

export function ToolBlock({ block }: { block: ToolRenderBlock }) {
  const { tool, input, output, status: st } = block

  // 运行中默认展开，其余状态默认折叠
  const [expanded, setExpanded] = useState(st === 'running')
  // 记录是否已自动收起过，避免覆盖用户后续的手动展开
  const [autoCollapsed, setAutoCollapsed] = useState(false)

  useEffect(() => {
    // 从 running 转入终态时，自动收起一次
    if (st !== 'running' && !autoCollapsed) {
      setExpanded(false)
      setAutoCollapsed(true)
    }
  }, [st, autoCollapsed])

  const toggle = () => setExpanded((v) => !v)
  const label = toolSummary(tool, input)

  return (
    <div className={wrap}>
      <button
        type="button"
        className={header}
        data-testid="tool-header"
        data-expanded={expanded}
        onClick={toggle}
      >
        <span className={icon} data-testid="tool-status" data-status={st}>
          {STATUS_ICON[st]}
        </span>
        <span className={summary}>
          {tool}
          {label ? ` · ${label}` : ''}
        </span>
        <span className={arrow}>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && st === 'paused' ? (
        <div className={body} style={{ fontSize: 13, color: 'var(--warning)' }}>
          等待权限确认
        </div>
      ) : expanded ? (
        <div className={body}>{renderTool(tool, input, output, st)}</div>
      ) : null}
    </div>
  )
}

function renderTool(
  tool: string,
  input: unknown,
  output: ToolRenderBlock['output'],
  status: string,
) {
  switch (tool) {
    case 'read':
      return <ReadToolView input={(input ?? {}) as never} output={output} status={status} />
    case 'write':
      return <WriteToolView input={(input ?? {}) as never} output={output} status={status} />
    case 'edit':
      return <EditToolView input={(input ?? {}) as never} output={output} status={status} />
    case 'bash':
      return <BashToolView input={(input ?? {}) as never} output={output} status={status} />
    case 'grep':
      return <GrepToolView input={(input ?? {}) as never} output={output} status={status} />
    case 'glob':
      return <GlobToolView input={(input ?? {}) as never} output={output} status={status} />
    default:
      return <FallbackToolView tool={tool} input={input} output={output} />
  }
}
