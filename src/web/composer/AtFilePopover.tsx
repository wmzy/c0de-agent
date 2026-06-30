import { css } from '@linaria/core'
import type { FileSearchResult } from '../hooks/useFiles.js'

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

type Props = {
  results: FileSearchResult[]
  activeIndex: number
  onSelect: (path: string) => void
}

function AtFilePopover(props: Props) {
  const files = props.results.filter((r) => r.type === 'file').slice(0, 20)
  if (files.length === 0) return null
  return (
    <div
      className={popover}
      role="listbox"
      data-testid="at-menu"
      onMouseDown={(e) => e.preventDefault()}
    >
      {files.map((f, i) => (
        <button
          key={f.path}
          role="option"
          aria-selected={i === props.activeIndex}
          className={`${item} ${i === props.activeIndex ? 'active' : ''}`}
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
