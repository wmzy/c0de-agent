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
  /* 允许收缩给右侧导航让位（窄屏防横向溢出）；项目名随之省略号截断 */
  min-width: 0;
`

const brand = css`
  display: inline-flex;
  align-items: center;
  color: var(--text);
  text-decoration: none;
  min-height: auto;
  flex-shrink: 0;
`

const nav = css`
  display: flex;
  align-items: center;
  gap: 4px;
  /* 导航不压缩：窄屏溢出压力由左侧品牌区（项目名截断）吸收 */
  flex-shrink: 0;
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

/** 全局顶部导航栏：品牌标识 + 主界面/看板/设置入口。 */
export function TopBar() {
  const { pathname } = useLocation()
  const { projectId } = useParams<{ projectId: string }>()
  const isSettings = pathname.startsWith('/settings')
  const isKanban = pathname.includes('/kanban')
  // 会话入口：项目上下文跳当前项目，否则回根路径（由 RootRedirect 解析当前项目）。
  const sessionsPath = projectId ? `/projects/${projectId}` : '/'
  const kanbanPath = projectId ? `/projects/${projectId}/kanban` : '/'

  return (
    <header className={bar} data-testid="topbar">
      <div className={brandGroup}>
        <Link to="/" className={brand} title="c0de-agent 首页">
          {/* 仅显示品牌 mark：字标与右侧项目切换器的项目名（可能恰为 c0de-agent）
              同字样相邻会造成品牌/项目身份混淆，品牌名由 Logo 内 sr-only 文本保留 */}
          <Logo wordmark={false} />
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
          className={`${link} ${!isSettings && !isKanban ? activeLink : ''}`}
          data-active={(!isSettings && !isKanban) || undefined}
        >
          会话
        </Link>
        <Link
          to={kanbanPath}
          className={`${link} ${isKanban ? activeLink : ''}`}
          data-active={isKanban || undefined}
          data-testid="nav-kanban"
        >
          看板
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
