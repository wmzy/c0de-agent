import { css } from '@linaria/core'
import { useLocation, useNavigate } from 'react-router-dom'
import { MOBILE } from '../styles/breakpoints.js'

const bar = css`
  display: none;
  ${MOBILE} {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 56px;
    border-top: 1px solid var(--border);
    background: var(--bg);
    z-index: 100;
  }
`

const tab = css`
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
  padding: 6px 0;
  &.active {
    color: var(--primary);
  }
`

const icon = css`
  font-size: 18px;
`

type Tab = { id: string; label: string; icon: string; kind: 'chat' | 'sessions' | 'settings' }

const TABS: Tab[] = [
  { id: 'chat', label: '对话', icon: '💬', kind: 'chat' },
  { id: 'sessions', label: '会话', icon: '🗂', kind: 'sessions' },
  { id: 'settings', label: '设置', icon: '⚙', kind: 'settings' },
]

/**
 * 移动端底部导航栏（spec §10.3）。桌面端（≥1024px）隐藏。
 *
 * 三个标签：对话 / 会话 / 设置。会话标签在 MVP 复用项目路由的侧边栏抽屉，
 * 点击停留在当前项目路由（侧边栏以抽屉形式呈现是后续工作）。
 */
export function MobileNav() {
  const navigate = useNavigate()
  const location = useLocation()
  const activeId = location.pathname.startsWith('/settings') ? 'settings' : 'chat' // sessions 复用 chat 路由

  const onPick = (t: Tab) => {
    if (t.kind === 'settings') navigate('/settings')
    // chat / sessions 在 MVP 中均留在当前项目路由
  }

  return (
    <nav className={bar} data-testid="mobile-nav">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`${tab} ${activeId === t.id ? 'active' : ''}`}
          data-testid={`mobile-nav-${t.id}`}
          onClick={() => onPick(t)}
        >
          <span className={icon}>{t.icon}</span>
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  )
}
