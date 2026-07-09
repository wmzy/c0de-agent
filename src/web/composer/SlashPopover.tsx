import { css } from '@linaria/core'
import fuzzysort from 'fuzzysort'
import { useMemo } from 'react'
import type { CommandInfo } from '../hooks/useCommands.js'

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

const cmdDesc = css`
  font-size: 12px;
  color: var(--text-secondary);
`

type Props = {
  query: string
  commands: CommandInfo[]
  activeIndex: number
  onSelect: (name: string) => void
}

function SlashPopover(props: Props) {
  const filtered = useMemo(() => {
    if (!props.query) return props.commands
    return fuzzysort.go(props.query, props.commands, { key: 'name' }).map((r) => r.obj)
  }, [props.query, props.commands])

  if (filtered.length === 0) return null
  return (
    <div
      className={popover}
      role="listbox"
      data-testid="slash-menu"
      onMouseDown={(e) => e.preventDefault()}
    >
      {filtered.map((c, i) => (
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

export { SlashPopover }
