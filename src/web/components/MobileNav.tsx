import { css } from '@linaria/core'
import { useMatched, useRouter } from '@native-router/react'
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { navigateTo } from '@/navigateTo.js'
import { MOBILE } from '@/styles/breakpoints.js'

const bar = css`
  display: none;
  ${MOBILE} {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 56px;
    border-top: 1px solid var(--haze-color-border);
    background: var(--haze-color-bg);
    z-index: 100;
  }
`

const tab = css`
  flex: 1;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: none;
  background: transparent;
  color: var(--haze-color-text-secondary);
  cursor: pointer;
  font-size: 11px;
  padding: 6px 0;
  &.active {
    color: var(--haze-color-primary);
    &::before {
      content: '';
      position: absolute;
      top: 0;
      left: 30%;
      right: 30%;
      height: 2px;
      background: var(--haze-color-primary);
      border-radius: 0 0 2px 2px;
    }
  }
`

const icon = css`
  font-size: 18px;
  transition: transform 0.15s;
  &.activeIcon {
    transform: scale(1.15);
  }
`

type Tab = { id: string; label: string; icon: string; kind: 'chat' | 'sessions' | 'settings' }

const TABS: Tab[] = [
  { id: 'chat', label: '对话', icon: '💬', kind: 'chat' },
  { id: 'sessions', label: '会话', icon: '🗂', kind: 'sessions' },
  { id: 'settings', label: '设置', icon: '⚙', kind: 'settings' },
]

type MobileNavProps = {
  /** 桌面侧栏内容（SidebarTabs：会话列表 + 文件树）；缺省时不提供会话入口。 */
  sidebar?: ReactNode
  /** Workbench 移动端侧栏覆盖层是否打开（替代原抽屉开闭状态）。 */
  sessionsOpen?: boolean
  /** 切换移动端侧栏覆盖层（Layout 持有 Workbench control）。 */
  onToggleSessions?: () => void
  /** 路由变化时收起覆盖层（抽屉内选择会话后自动收起）。 */
  onSessionsClosed?: () => void
}

/**
 * 移动端底部导航栏（spec §10.3）。桌面端隐藏。
 *
 * 三个标签：对话 / 会话 / 设置。「会话」打开 Workbench 的移动端
 * 侧栏覆盖层（滑出 + 遮罩 + Esc 关闭 + 焦点管理均由 Workbench
 * 内置）；路由变化（如在覆盖层内选择会话）时自动收起。
 * 无侧栏内容的页面（如看板）点击「会话」无操作。
 */
export function MobileNav({
  sidebar,
  sessionsOpen = false,
  onToggleSessions,
  onSessionsClosed,
}: MobileNavProps) {
  const router = useRouter()
  // notFound 视图提交在匹配链之外（无 MatchedContext），useMatched 返回 undefined；
  // 404 页仍需渲染移动导航，故按缺省路径处理。
  const matchedCtx = useMatched()
  const routePath = matchedCtx?.matched[matchedCtx.matched.length - 1]?.route.path ?? ''
  const projectId = matchedCtx?.params.projectId

  // 路由变化（如在覆盖层内选择会话/进入设置）时收起覆盖层
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅监听路由变化触发收起，effect 内无需读取
  useEffect(() => {
    onSessionsClosed?.()
  }, [matchedCtx])

  // 覆盖层打开时高亮 sessions 标签；否则按路由判定
  const isSettingsRoute = routePath === '/settings' || routePath === '/projects/:projectId/settings'
  const activeId = sessionsOpen ? 'sessions' : isSettingsRoute ? 'settings' : 'chat'

  const onPick = (t: Tab) => {
    if (t.kind === 'settings') {
      if (projectId) {
        navigateTo(router, '/projects/:projectId/settings', { params: { projectId } })
      } else {
        navigateTo(router, '/settings')
      }
      return
    }
    if (t.kind === 'chat') {
      // 设置页点「对话」应回到聊天页（此前仅收起覆盖层，无导航）。
      // 未保存更改由 Settings 的 useBlocker 统一拦截（含程序化导航），此处直接跳。
      if (isSettingsRoute) {
        if (projectId) {
          navigateTo(router, '/projects/:projectId', { params: { projectId } })
        } else {
          navigateTo(router, '/')
        }
      }
      onSessionsClosed?.()
      return
    }
    // sessions：有侧栏内容时开/合覆盖层
    if (sidebar) onToggleSessions?.()
  }

  return (
    <nav className={bar} data-testid="mobile-nav">
      {TABS.map((t) => {
        const active = activeId === t.id
        return (
          <button
            key={t.id}
            type="button"
            className={`${tab} ${active ? 'active' : ''}`}
            data-testid={`mobile-nav-${t.id}`}
            onClick={() => onPick(t)}
          >
            <span className={`${icon} ${active ? 'activeIcon' : ''}`}>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
