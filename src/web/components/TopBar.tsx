import { css } from '@linaria/core'
import { Link, useLocation } from 'react-router-dom'

const bar = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 44px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  flex-shrink: 0;
`

const brand = css`
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  font-size: 14px;
  color: var(--text);
  text-decoration: none;
  min-height: auto;
`

const nav = css`
  display: flex;
  align-items: center;
  gap: 4px;
`

const link = css`
  display: inline-flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 13px;
  color: var(--text-secondary);
  text-decoration: none;
  min-height: auto;
  min-width: auto;
  cursor: pointer;
  &:hover {
    background: var(--bg);
    color: var(--text);
  }
`

const activeLink = css`
  background: var(--bg);
  color: var(--primary);
  font-weight: 600;
`

const dot = css`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--primary);
  display: inline-block;
`

/** 全局顶部导航栏：品牌标识 + 主界面/设置入口。 */
export function TopBar() {
  const { pathname } = useLocation()
  const isSettings = pathname.startsWith('/settings')

  return (
    <header className={bar} data-testid="topbar">
      <Link to="/" className={brand}>
        <span className={dot} />
        c0de-agent
      </Link>
      <nav className={nav}>
        <Link
          to="/"
          className={`${link} ${!isSettings ? activeLink : ''}`}
          data-active={!isSettings || undefined}
        >
          会话
        </Link>
        <Link
          to="/settings"
          className={`${link} ${isSettings ? activeLink : ''}`}
          data-active={isSettings || undefined}
        >
          设置
        </Link>
      </nav>
    </header>
  )
}
