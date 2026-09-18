import { css } from '@linaria/core'
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

type Props = {
  commands: CommandInfo[]
  activeIndex: number
  onSelect: (name: string) => void
}

type SubcommandProps = {
  subcommands: SubcommandDef[]
  activeIndex: number
  onSelect: (name: string) => void
  parentCommand: string
}

function SlashPopover(props: Props) {
  if (props.commands.length === 0) return null
  return (
    <div
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
  if (props.subcommands.length === 0) return null
  return (
    <div
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
