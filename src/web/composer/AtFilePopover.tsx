import { css } from '@linaria/core'
import { useRef } from 'react'
import { PopoverError } from '@/composer/PopoverError.js'
import { usePopoverScroll } from '@/composer/usePopoverScroll.js'
import type { FileSearchResult } from '@/hooks/useFiles.js'
import type { AgentListItem } from '@/services/agent.js'

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
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  cursor: pointer;
  background: none;
  border: none;
  color: var(--haze-color-text);
  font-size: 13px;
  &:hover,
  &.active {
    background: var(--haze-color-bg-subtle);
  }
`

/** @agent 提及项的强调标签（@name）。 */
const agentLabel = css`
  color: var(--haze-color-primary, #4a9eff);
  font-weight: 600;
  font-size: 11px;
  display: block;
  margin-bottom: 2px;
`

/** 加载/空态提示行（非候选项，不参与键盘索引）。 */
const hint = css`
  padding: 8px 12px;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
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
  const listRef = useRef<HTMLDivElement>(null)
  usePopoverScroll(listRef, activeIndex, true)
  // 候选为空时区分「搜完了没有匹配」与「还在搜」：后者此前 return null——
  // 浮层整个消失，用户看到的是「没有候选」，而搜索结果几十毫秒后才到。
  if (files.length === 0 && subagents.length === 0) {
    // 失败优先于「空」：把「搜不了」渲染成「没有匹配」会让用户按 Enter 把
    // 字面量 `@foo` 当正文发出去（此前文件搜索 500 时浮层直接消失）。
    if (props.error) {
      return (
        <div className={popover} data-testid="at-menu-error">
          <PopoverError message={`文件搜索失败：${props.error}`} onRetry={props.onRetry} />
        </div>
      )
    }
    if (!props.loading) return null
    return (
      <div className={popover} role="status" data-testid="at-menu-loading">
        <div className={hint}>搜索中…</div>
      </div>
    )
  }
  return (
    <div
      ref={listRef}
      className={popover}
      role="listbox"
      data-testid="at-menu"
      onMouseDown={(e) => e.preventDefault()}
    >
      {subagents.map((a, i) => (
        <button
          key={a.name}
          role="option"
          aria-selected={i === activeIndex}
          className={`${item} ${i === activeIndex ? 'active' : ''}`}
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
          aria-selected={subagents.length + i === activeIndex}
          className={`${item} ${subagents.length + i === activeIndex ? 'active' : ''}`}
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
