import { css } from '@linaria/core'
import type { WorkflowInfo } from '../services/workflows.js'

const popover = css`
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
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
  color: var(--text);
  &:hover,
  &.active {
    background: var(--bg-secondary);
  }
`

const wfDesc = css`
  font-size: 12px;
  color: var(--text-secondary);
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

type Props = {
  workflows: WorkflowInfo[]
  activeIndex: number
  onSelect: (name: string) => void
}

function WorkflowPopover(props: Props) {
  if (props.workflows.length === 0) return null
  return (
    <div
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
          </span>
          {wf.description && <span className={wfDesc}>{wf.description}</span>}
        </button>
      ))}
    </div>
  )
}

export { WorkflowPopover }
