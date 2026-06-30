import { css } from '@linaria/core'
import type { ReactNode } from 'react'
import { MobileNav } from '../components/MobileNav.js'
import { DESKTOP, MOBILE } from '../styles/breakpoints.js'

const layoutStyle = css`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  width: 100%;
`

const bodyStyle = css`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  ${DESKTOP} {
    flex-direction: row;
  }
`

const sidebarStyle = css`
  display: none;
  width: 100%;
  ${DESKTOP} {
    display: flex;
    flex-direction: column;
    width: 280px;
    border-right: 1px solid var(--border);
    flex-shrink: 0;
  }
`

const mainStyle = css`
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  ${MOBILE} {
    padding-bottom: 56px;
  }
`

const panelStyle = css`
  display: none;
  ${DESKTOP} {
    display: flex;
    width: 360px;
    border-left: 1px solid var(--border);
    flex-shrink: 0;
  }
`

type LayoutProps = {
  header?: ReactNode
  sidebar?: ReactNode
  main: ReactNode
  panel?: ReactNode
}

export function Layout({
  header: headerNode,
  sidebar: sidebarNode,
  main: mainNode,
  panel: panelNode,
}: LayoutProps) {
  return (
    <div className={layoutStyle}>
      {headerNode && <>{headerNode}</>}
      <div className={bodyStyle}>
        {sidebarNode && <aside className={sidebarStyle}>{sidebarNode}</aside>}
        <main className={mainStyle}>{mainNode}</main>
        {panelNode && <aside className={panelStyle}>{panelNode}</aside>}
      </div>
      {/* 移动端底部导航栏（spec §10.3）；桌面端由组件内部隐藏 */}
      <MobileNav />
    </div>
  )
}
