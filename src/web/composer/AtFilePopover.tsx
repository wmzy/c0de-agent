import { css } from '@linaria/core'
import type { FileSearchResult } from '../hooks/useFiles.js'
import type { AgentListItem } from '../services/agent.js'

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
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  cursor: pointer;
  background: none;
  border: none;
  color: var(--text);
  font-size: 13px;
  &:hover,
  &.active {
    background: var(--bg-secondary);
  }
`

/** @agent 提及项的强调标签（@name）。 */
const agentLabel = css`
  color: var(--accent, #4a9eff);
  font-weight: 600;
  font-size: 11px;
  display: block;
  margin-bottom: 2px;
`

type Props = {
  results: FileSearchResult[]
  activeIndex: number
  onSelect: (path: string) => void
  /** 可用 agent 列表（@ mention 渲染）。 */
  agents: AgentListItem[]
  /** 当前 @ 查询串（过滤 agent name）。 */
  query: string
  /** agent 项的键盘高亮索引。 */
  activeAgentIndex: number
  /** 选中 agent 时回调（插入 @name 文本）。 */
  onAgentSelect: (name: string) => void
}

function AtFilePopover(props: Props) {
  const files = props.results.filter((r) => r.type === 'file').slice(0, 20)
  // @ mention 只显示非 primary（可调用的 subagent/all），按 query 过滤 name
  const subagents = props.agents
    .filter((a) => a.mode !== 'primary')
    .filter((a) => !props.query || a.name.includes(props.query))
    .slice(0, 5)
  if (files.length === 0 && subagents.length === 0) return null
  return (
    <div
      className={popover}
      role="listbox"
      data-testid="at-menu"
      onMouseDown={(e) => e.preventDefault()}
    >
      {subagents.map((a, i) => (
        <button
          key={a.name}
          role="option"
          aria-selected={i === props.activeAgentIndex}
          className={`${item} ${i === props.activeAgentIndex ? 'active' : ''}`}
          onClick={() => props.onAgentSelect(a.name)}
          type="button"
        >
          <span className={agentLabel}>@{a.name}</span>
          <span>{a.description}</span>
        </button>
      ))}
      {files.map((f, i) => (
        <button
          key={f.path}
          role="option"
          aria-selected={subagents.length + i === props.activeIndex}
          className={`${item} ${subagents.length + i === props.activeIndex ? 'active' : ''}`}
          onClick={() => props.onSelect(f.path)}
          type="button"
        >
          {f.path}
        </button>
      ))}
    </div>
  )
}

export { AtFilePopover }
