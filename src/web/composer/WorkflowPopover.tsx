import { css } from '@linaria/core'
import { useRef } from 'react'
import { usePopoverScroll } from '@/composer/usePopoverScroll.js'
import type { WorkflowInfo } from '@/services/workflows.js'

const popover = css`
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  box-shadow: var(--haze-shadow-md);
  max-height: 240px;
  overflow: auto;
  z-index: 10;
`

const item = css`
  display: flex;
  flex-direction: column;
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  cursor: pointer;
  background: none;
  border: none;
  color: var(--haze-color-text);
  &:hover,
  &.active {
    background: var(--haze-color-bg-subtle);
  }
`

const wfDesc = css`
  font-size: 12px;
  color: var(--haze-color-text-secondary);
`

const wfArgs = css`
  font-size: 11px;
  color: var(--haze-color-text-secondary);
  opacity: 0.7;
  font-family: var(--haze-font-mono, monospace);
`

/** 加载/空态提示行（非候选项，不参与键盘索引）。 */
const hint = css`
  padding: 8px 12px;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
`

const sourceTag = css`
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 6px;
  vertical-align: middle;
  &.builtin {
    background: rgba(99, 102, 241, 0.15);
    color: #818cf8;
  }
  &.project {
    background: rgba(34, 197, 94, 0.15);
    color: #4ade80;
  }
  &.user {
    background: rgba(245, 158, 11, 0.15);
    color: #fbbf24;
  }
`

const nameRow = css`
  display: flex;
  align-items: center;
  gap: 4px;
`

const overrideTag = css`
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 2px;
  vertical-align: middle;
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
`

type Props = {
  workflows: WorkflowInfo[]
  activeIndex: number
  /** 工作流列表仍在加载中（结果未到）。 */
  loading?: boolean
  onSelect: (name: string) => void
}

function WorkflowPopover(props: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  usePopoverScroll(listRef, props.activeIndex, props.workflows.length > 0)
  // 加载中与「确实没有工作流」此前都渲染成空——浮层消失，用户看不出区别。
  if (props.workflows.length === 0) {
    if (!props.loading) return null
    return (
      <div className={popover} role="status" data-testid="workflow-menu-loading">
        <div className={hint}>工作流加载中…</div>
      </div>
    )
  }
  return (
    <div
      ref={listRef}
      className={popover}
      role="listbox"
      data-testid="workflow-menu"
      onMouseDown={(e) => e.preventDefault()}
    >
      {props.workflows.map((wf, i) => (
        <button
          key={wf.name}
          role="option"
          aria-selected={i === props.activeIndex}
          className={`${item} ${i === props.activeIndex ? 'active' : ''}`}
          onClick={() => props.onSelect(wf.name)}
          type="button"
        >
          <span className={nameRow}>
            <strong>{wf.name}</strong>
            <span className={`${sourceTag} ${wf.source}`}>{wf.source}</span>
            {wf.overrides ? (
              <span className={overrideTag} title="该项目工作流与内置/用户工作流同名，将覆盖原实现">
                覆盖{wf.overrides === 'builtin' ? '内置' : '用户'}
              </span>
            ) : null}
          </span>
          {wf.description && <span className={wfDesc}>{wf.description}</span>}
          {wf.argsHint && <span className={wfArgs}>参数: {wf.argsHint}</span>}
        </button>
      ))}
    </div>
  )
}

export { WorkflowPopover }
