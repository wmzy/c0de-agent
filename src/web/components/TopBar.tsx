import { css } from '@linaria/core'
import { Link, useLocation, useParams } from 'react-router-dom'
import { CommitButton } from './CommitButton.js'
import { Logo } from './Logo.js'
import { ProjectIndicator } from './ProjectIndicator.js'

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

const brandGroup = css`
  display: flex;
  align-items: center;
  gap: 8px;
`

const brand = css`
  display: inline-flex;
  align-items: center;
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

/** 全局顶部导航栏：品牌标识 + 主界面/设置入口。 */
export function TopBar() {
  const { pathname } = useLocation()
  const { projectId } = useParams<{ projectId: string }>()
  const isSettings = pathname.startsWith('/settings')
  // 会话入口：项目上下文跳当前项目，否则回根路径（由 RootRedirect 解析当前项目）。
  const sessionsPath = projectId ? `/projects/${projectId}` : '/'

  return (
    <header className={bar} data-testid="topbar">
      <div className={brandGroup}>
        <Link to="/" className={brand}>
          <Logo />
        </Link>
        {projectId && (
          <ProjectIndicator
            projectId={projectId}
            variant="inline"
            actions={<CommitButton projectId={projectId} />}
          />
        )}
      </div>
      <nav className={nav}>
        <Link
          to={sessionsPath}
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
