import { css } from '@linaria/core'
import { PopoverList, PopoverOption } from '@/composer/PopoverList.js'
import type { WorkflowInfo } from '@/services/workflows.js'

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
  /** 工作流列表读取失败的原因（已取 message）；非空即渲染失败行。 */
  error?: string | null
  /** 失败行的重试入口。 */
  onRetry?: () => void
  onSelect: (name: string) => void
}

function WorkflowPopover(props: Props) {
  return (
    <PopoverList
      itemCount={props.workflows.length}
      activeIndex={props.activeIndex}
      loading={props.loading}
      error={props.error ? `工作流列表加载失败：${props.error}` : null}
      onRetry={props.onRetry}
      loadingHint="工作流加载中…"
      testId="workflow-menu"
    >
      {props.workflows.map((wf, i) => (
        <PopoverOption
          key={wf.name}
          active={i === props.activeIndex}
          onSelect={() => props.onSelect(wf.name)}
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
        </PopoverOption>
      ))}
    </PopoverList>
  )
}

export { WorkflowPopover }
