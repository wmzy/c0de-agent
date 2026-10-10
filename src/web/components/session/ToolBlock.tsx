import { css } from '@linaria/core'
import { type KeyboardEvent, memo, type ReactNode, useEffect, useState } from 'react'
import { FilePathLink } from '@/components/FilePathLink.js'
import { BashToolView } from '@/components/session/tools/BashToolView.js'
import { EditToolView } from '@/components/session/tools/EditToolView.js'
import { FallbackToolView } from '@/components/session/tools/FallbackToolView.js'
import { GlobToolView } from '@/components/session/tools/GlobToolView.js'
import { GrepToolView } from '@/components/session/tools/GrepToolView.js'
import { KanbanToolView } from '@/components/session/tools/KanbanToolView.js'
import { ReadToolView } from '@/components/session/tools/ReadToolView.js'
import { TaskToolView } from '@/components/session/tools/TaskToolView.js'
import { TodoToolView } from '@/components/session/tools/TodoToolView.js'
import { WriteToolView } from '@/components/session/tools/WriteToolView.js'
import type { RenderBlock } from '@/components/session/utils/normalizeParts.js'
import { toolSummary } from '@/components/session/utils/toolSummary.js'

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
  color: var(--haze-color-text-secondary);
  background: transparent;
  border: none;
  width: 100%;
  text-align: left;
`

/** 紧凑模式：连续 tool 组内减小 header 上下内距 */
const headerCompact = css`
  padding-top: 1px;
  padding-bottom: 1px;
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
  color: var(--haze-color-text);
`

const arrow = css`
  flex-shrink: 0;
  color: var(--haze-color-text-secondary);
`

const permissionPending = css`
  font-size: 13px;
  color: var(--haze-color-warning);
`

const body = css`
  margin-top: 2px;
`

export const ToolBlock = memo(function ToolBlock({
  block,
  forceExpand,
  compact,
}: {
  block: ToolRenderBlock
  forceExpand?: boolean
  compact?: boolean
}) {
  const { tool, input, output, status: st } = block

  // 只有成功态默认折叠：失败原因（toolError）与「等待权限确认」只存在于
  // 展开态，折叠等于把用户唯一能看到的问题藏成一个 ✗/🔒 图标。
  const [expanded, setExpanded] = useState(st !== 'completed')
  // 记录是否已自动收起过，避免覆盖用户后续的手动展开
  const [autoCollapsed, setAutoCollapsed] = useState(false)

  useEffect(() => {
    // 从 running 转入成功态时，自动收起一次；error/paused 保持展开
    if (st === 'completed' && !autoCollapsed) {
      setExpanded(false)
      setAutoCollapsed(true)
    }
  }, [st, autoCollapsed])

  const toggle = () => setExpanded((v) => !v)
  const onHeaderKeyDown = (e: KeyboardEvent) => {
    // header 里内嵌了 FilePathLink（真 <button>）等交互元素：事件从它们冒泡上来时
    // 必须放行。否则 preventDefault 会吃掉按钮自身的 Enter/Space 激活——文件预览
    // 链接键盘完全打不开，Enter 只把工具块折叠/展开。
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    }
  }

  // shake 模式强制展开（用户需看到完整内容判断是否 shake）
  const isExpanded = forceExpand || expanded

  return (
    <div className={wrap}>
      {/* biome-ignore lint/a11y/useSemanticElements: header 内嵌 FilePathLink(<button>)，HTML 禁止 button 嵌 button，必须用 div+role */}
      <div
        role="button"
        tabIndex={0}
        className={`${header} ${compact ? headerCompact : ''}`}
        data-testid="tool-header"
        data-expanded={isExpanded}
        onClick={toggle}
        onKeyDown={onHeaderKeyDown}
      >
        <span className={icon} data-testid="tool-status" data-status={st}>
          {STATUS_ICON[st]}
        </span>
        <span className={summary} data-testid="tool-summary">
          {tool}
          {renderHeaderSummary(tool, input)}
        </span>
        <span className={arrow}>{isExpanded ? '▾' : '▸'}</span>
      </div>
      {isExpanded && st === 'paused' ? (
        <div className={`${body} ${permissionPending}`} data-testid="tool-body">
          等待权限确认
        </div>
      ) : isExpanded ? (
        <div className={body} data-testid="tool-body">
          {renderTool(tool, input, output, st)}
        </div>
      ) : null}
    </div>
  )
})

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
    case 'task':
      return <TaskToolView input={input} output={output} status={status} />
    case 'todo':
      return <TodoToolView input={input} output={output} status={status} />
    case 'kanban':
      return <KanbanToolView input={input} output={output} status={status} />
    default:
      return <FallbackToolView tool={tool} input={input} output={output} />
  }
}

/** header 摘要：文件类工具渲染可点击路径，其余用纯文本摘要。 */
function renderHeaderSummary(tool: string, input: unknown): ReactNode {
  const i = (input ?? {}) as Record<string, unknown>
  if (
    (tool === 'read' || tool === 'write' || tool === 'edit') &&
    typeof i.path === 'string' &&
    i.path
  ) {
    return (
      <>
        {' · '}
        {/* 阻止路径点击冒泡到 header 的展开/收起 */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: span 仅用于 stopPropagation 隔离冒泡，非交互元素 */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: 纯事件隔离，无交互语义，无需键盘事件 */}
        <span onClick={(e) => e.stopPropagation()}>
          <FilePathLink path={i.path} />
        </span>
      </>
    )
  }
  const label = toolSummary(tool, input)
  return label ? ` · ${label}` : null
}
