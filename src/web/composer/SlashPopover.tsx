import { css } from '@linaria/core'
import { useRef } from 'react'
import { PopoverError } from '@/composer/PopoverError.js'
import { usePopoverScroll } from '@/composer/usePopoverScroll.js'
import type { CommandInfo } from '@/hooks/useCommands.js'
import type { SubcommandDef } from '@/services/commands.js'

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

const cmdDesc = css`
  font-size: 12px;
  color: var(--haze-color-text-secondary);
`

const cmdUsage = css`
  font-size: 11px;
  color: var(--haze-color-text-muted, var(--haze-color-text-secondary));
  font-family: var(--haze-font-mono, monospace);
`

/** 加载/空态提示行（非候选项，不参与键盘索引）。 */
const hint = css`
  padding: 8px 12px;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
`

type Props = {
  commands: CommandInfo[]
  activeIndex: number
  /** 命令列表仍在加载中（结果未到）。 */
  loading?: boolean
  /** 命令列表读取失败的原因（已取 message）；非空即渲染失败行而不是空浮层。 */
  error?: string | null
  /** 失败行的重试入口。 */
  onRetry?: () => void
  onSelect: (name: string) => void
}

type SubcommandProps = {
  subcommands: SubcommandDef[]
  activeIndex: number
  /** 命令列表仍在加载中（结果未到）。 */
  loading?: boolean
  /** 命令列表读取失败的原因（已取 message）；非空即渲染失败行而不是空浮层。 */
  error?: string | null
  /** 失败行的重试入口。 */
  onRetry?: () => void
  onSelect: (name: string) => void
  parentCommand: string
}

function SlashPopover(props: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  usePopoverScroll(listRef, props.activeIndex, props.commands.length > 0)
  // 空列表不等于「没有这个命令」：加载中此前同样 return null，浮层消失后用户
  // 只能看到「没有任何命令匹配」。
  if (props.commands.length === 0) {
    // 失败优先于「空/加载中」：命令列表读不到时此前浮层整个消失，
    // 用户以为「没有这个命令」，Enter 还照样把字面量 /cmd 发出去。
    if (props.error) {
      return (
        <div className={popover} data-testid="slash-menu-error">
          <PopoverError message={`命令列表加载失败：${props.error}`} onRetry={props.onRetry} />
        </div>
      )
    }
    if (!props.loading) return null
    return (
      <div className={popover} role="status" data-testid="slash-menu-loading">
        <div className={hint}>命令加载中…</div>
      </div>
    )
  }
  return (
    <div
      ref={listRef}
      className={popover}
      role="listbox"
      data-testid="slash-menu"
      onMouseDown={(e) => e.preventDefault()}
    >
      {props.commands.map((c, i) => (
        <button
          key={c.name}
          role="option"
          aria-selected={i === props.activeIndex}
          className={`${item} ${i === props.activeIndex ? 'active' : ''}`}
          onClick={() => props.onSelect(c.name)}
          type="button"
        >
          <strong>/{c.name}</strong>
          {c.description && <span className={cmdDesc}>{c.description}</span>}
        </button>
      ))}
    </div>
  )
}

function SubcommandPopover(props: SubcommandProps) {
  const listRef = useRef<HTMLDivElement>(null)
  usePopoverScroll(listRef, props.activeIndex, props.subcommands.length > 0)
  if (props.subcommands.length === 0) {
    if (props.error) {
      return (
        <div className={popover} data-testid="subcommand-menu-error">
          <PopoverError message={`命令列表加载失败：${props.error}`} onRetry={props.onRetry} />
        </div>
      )
    }
    if (!props.loading) return null
    return (
      <div className={popover} role="status" data-testid="subcommand-menu-loading">
        <div className={hint}>命令加载中…</div>
      </div>
    )
  }
  return (
    <div
      ref={listRef}
      className={popover}
      role="listbox"
      data-testid="subcommand-menu"
      onMouseDown={(e) => e.preventDefault()}
    >
      {props.subcommands.map((c, i) => (
        <button
          key={c.name}
          role="option"
          aria-selected={i === props.activeIndex}
          className={`${item} ${i === props.activeIndex ? 'active' : ''}`}
          onClick={() => props.onSelect(c.name)}
          type="button"
        >
          <strong>
            /{props.parentCommand} {c.name}
          </strong>
          {c.description && <span className={cmdDesc}>{c.description}</span>}
          {c.usage && <span className={cmdUsage}>{c.usage}</span>}
        </button>
      ))}
    </div>
  )
}

export { SlashPopover, SubcommandPopover }
