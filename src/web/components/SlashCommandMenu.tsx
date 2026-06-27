import { css } from '@linaria/core'

const menu = css`
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
`

const item = css`
  display: flex;
  flex-direction: column;
  padding: 8px 12px;
  cursor: pointer;
  &:hover {
    background: var(--bg-secondary);
  }
`

const COMMANDS = [
  { name: '/clear', desc: '清除当前会话' },
  { name: '/fork', desc: '从当前消息分支' },
  { name: '/compact', desc: '压缩上下文' },
  { name: '/help', desc: '查看帮助' },
]

export function SlashCommandMenu({
  query,
  onPick,
}: {
  query: string
  onPick: (cmd: string) => void
}) {
  const filtered = COMMANDS.filter((c) => c.name.startsWith(query))
  if (filtered.length === 0) return null
  return (
    <div className={menu} data-testid="slash-menu">
      {filtered.map((c) => (
        <button key={c.name} className={item} onClick={() => onPick(c.name)} type="button">
          <strong>{c.name}</strong>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{c.desc}</span>
        </button>
      ))}
    </div>
  )
}
