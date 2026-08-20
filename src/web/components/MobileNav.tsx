import { css } from '@linaria/core'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
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
  position: relative;
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
    &::before {
      content: '';
      position: absolute;
      top: 0;
      left: 30%;
      right: 30%;
      height: 2px;
      background: var(--primary);
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

/** 抽屉根容器：遮罩 + 面板，避让底部 56px 导航栏（保证「再次点 tab」可关闭）。 */
const drawerRoot = css`
  display: none;
  ${MOBILE} {
    display: block;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 56px;
    z-index: 110;
  }
`

/** 遮罩：全屏 button（键盘可达），点击关闭抽屉。 */
const drawerMask = css`
  position: absolute;
  inset: 0;
  border: none;
  padding: 0;
  min-height: 0;
  min-width: 0;
  background: rgba(0, 0, 0, 0.45);
  cursor: pointer;
`

/** 侧滑面板：左缘贴边，内嵌桌面侧栏（SidebarTabs：会话列表 + 文件树）。 */
const drawerPanel = css`
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: min(85vw, 340px);
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-right: 1px solid var(--border);
  box-shadow: 4px 0 16px rgba(0, 0, 0, 0.18);
  animation: mobile-drawer-in 0.2s ease;
  @keyframes mobile-drawer-in {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(0);
    }
  }
`

const drawerHeader = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  flex-shrink: 0;
`

const closeBtn = css`
  min-height: 32px;
  min-width: 32px;
  padding: 4px 10px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
`

const drawerBody = css`
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
`

type Tab = { id: string; label: string; icon: string; kind: 'chat' | 'sessions' | 'settings' }

const TABS: Tab[] = [
  { id: 'chat', label: '对话', icon: '💬', kind: 'chat' },
  { id: 'sessions', label: '会话', icon: '🗂', kind: 'sessions' },
  { id: 'settings', label: '设置', icon: '⚙', kind: 'settings' },
]

type MobileNavProps = {
  /** 桌面侧栏内容（SidebarTabs：会话列表 + 文件树），移动端以抽屉形式复用；缺省时不提供抽屉。 */
  sidebar?: ReactNode
}

/**
 * 移动端底部导航栏（spec §10.3）。桌面端（≥1024px…实际 ≥768px）隐藏。
 *
 * 三个标签：对话 / 会话 / 设置。「会话」以侧滑抽屉复用 Layout 的侧栏
 * （会话列表 + 文件 tab）；关闭方式：再次点标签 / 点遮罩 / ✕ / Esc，
 * 抽屉内导航（选择会话）时自动收起。无侧栏内容的页面（如看板）点击无操作。
 */
export function MobileNav({ sidebar }: MobileNavProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [drawerOpen, setDrawerOpen] = useState(false)

  // 路由变化（如在抽屉内选择会话/进入设置）时收起抽屉
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅监听路由变化触发收起，effect 内无需读取 pathname
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  // 抽屉打开时：Esc 关闭 + 锁定背景滚动
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
    }
  }, [drawerOpen])

  // 抽屉打开时高亮 sessions 标签；否则按路由判定
  const activeId = drawerOpen
    ? 'sessions'
    : location.pathname.startsWith('/settings')
      ? 'settings'
      : 'chat'

  const onPick = (t: Tab) => {
    if (t.kind === 'settings') {
      navigate('/settings')
      return
    }
    if (t.kind === 'chat') {
      setDrawerOpen(false)
      return
    }
    // sessions：有侧栏内容时开/合抽屉
    if (sidebar) setDrawerOpen((o) => !o)
  }

  return (
    <>
      <nav className={bar} data-testid="mobile-nav">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`${tab} ${activeId === t.id ? 'active' : ''}`}
            data-testid={`mobile-nav-${t.id}`}
            onClick={() => onPick(t)}
            aria-expanded={t.kind === 'sessions' && sidebar ? drawerOpen : undefined}
          >
            <span className={`${icon} ${activeId === t.id ? 'activeIcon' : ''}`}>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
      {drawerOpen && sidebar && (
        <div className={drawerRoot} data-testid="mobile-drawer-root">
          <button
            type="button"
            className={drawerMask}
            aria-label="关闭抽屉"
            data-testid="mobile-drawer-mask"
            onClick={() => setDrawerOpen(false)}
          />
          <section
            className={drawerPanel}
            role="dialog"
            aria-modal="true"
            aria-label="会话与文件"
            data-testid="mobile-drawer"
          >
            <div className={drawerHeader}>
              <span>会话与文件</span>
              <button
                type="button"
                className={closeBtn}
                aria-label="关闭侧栏"
                data-testid="mobile-drawer-close"
                onClick={() => setDrawerOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className={drawerBody}>{sidebar}</div>
          </section>
        </div>
      )}
    </>
  )
}
