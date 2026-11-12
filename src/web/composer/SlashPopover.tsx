import { css } from '@linaria/core'
import { PopoverList, PopoverOption } from '@/composer/PopoverList.js'
import type { CommandInfo } from '@/hooks/useCommands.js'
import type { SubcommandDef } from '@/services/commands.js'

const cmdDesc = css`
  font-size: 12px;
  color: var(--haze-color-text-secondary);
`

const cmdUsage = css`
  font-size: 11px;
  color: var(--haze-color-text-muted, var(--haze-color-text-secondary));
  font-family: var(--haze-font-mono, monospace);
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
  return (
    <PopoverList
      itemCount={props.commands.length}
      activeIndex={props.activeIndex}
      loading={props.loading}
      error={props.error ? `命令列表加载失败：${props.error}` : null}
      onRetry={props.onRetry}
      loadingHint="命令加载中…"
      testId="slash-menu"
    >
      {props.commands.map((c, i) => (
        <PopoverOption
          key={c.name}
          active={i === props.activeIndex}
          onSelect={() => props.onSelect(c.name)}
        >
          <strong>/{c.name}</strong>
          {c.description && <span className={cmdDesc}>{c.description}</span>}
        </PopoverOption>
      ))}
    </PopoverList>
  )
}

function SubcommandPopover(props: SubcommandProps) {
  return (
    <PopoverList
      itemCount={props.subcommands.length}
      activeIndex={props.activeIndex}
      loading={props.loading}
      error={props.error ? `命令列表加载失败：${props.error}` : null}
      onRetry={props.onRetry}
      loadingHint="命令加载中…"
      testId="subcommand-menu"
    >
      {props.subcommands.map((c, i) => (
        <PopoverOption
          key={c.name}
          active={i === props.activeIndex}
          onSelect={() => props.onSelect(c.name)}
        >
          <strong>
            /{props.parentCommand} {c.name}
          </strong>
          {c.description && <span className={cmdDesc}>{c.description}</span>}
          {c.usage && <span className={cmdUsage}>{c.usage}</span>}
        </PopoverOption>
      ))}
    </PopoverList>
  )
}

export { SlashPopover, SubcommandPopover }
