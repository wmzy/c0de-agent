import { css } from '@linaria/core'
import { PopoverList, PopoverOption } from '@/composer/PopoverList.js'
import type { FileSearchResult } from '@/hooks/useFiles.js'
import type { AgentListItem } from '@/services/agent.js'

/** @agent 提及项的强调标签（@name）。 */
const agentLabel = css`
  color: var(--haze-color-primary, #4a9eff);
  font-weight: 600;
  font-size: 11px;
  display: block;
  margin-bottom: 2px;
`

type Props = {
  /** @agent 段（已按 query 过滤并截断，由 at-menu.ts 统一算好）。 */
  subagents: AgentListItem[]
  /** @文件段（已截断，与键盘索引空间同源）。 */
  files: FileSearchResult[]
  /** 扁平键盘索引：下标落在 agent 段还是文件段由 subagents.length 决定。 */
  activeIndex: number
  /** 文件搜索仍在进行中（结果未到）。 */
  loading?: boolean
  /** 文件搜索失败的原因（已取 message）；非空即渲染失败行而不是空浮层。 */
  error?: string | null
  /** 失败行的重试入口。 */
  onRetry?: () => void
  onSelect: (path: string) => void
  /** 选中 agent 时回调（插入 @name 文本）。 */
  onAgentSelect: (name: string) => void
}

function AtFilePopover(props: Props) {
  const { subagents, files, activeIndex } = props
  return (
    <PopoverList
      itemCount={subagents.length + files.length}
      activeIndex={activeIndex}
      loading={props.loading}
      error={props.error ? `文件搜索失败：${props.error}` : null}
      onRetry={props.onRetry}
      loadingHint="搜索中…"
      testId="at-menu"
    >
      {subagents.map((a, i) => (
        <PopoverOption
          key={a.name}
          block
          active={i === activeIndex}
          onSelect={() => props.onAgentSelect(a.name)}
        >
          <span className={agentLabel}>@{a.name}</span>
          <span>{a.description}</span>
        </PopoverOption>
      ))}
      {files.map((f, i) => (
        <PopoverOption
          key={f.path}
          block
          active={subagents.length + i === activeIndex}
          onSelect={() => props.onSelect(f.path)}
        >
          {f.path}
        </PopoverOption>
      ))}
    </PopoverList>
  )
}

export { AtFilePopover }
