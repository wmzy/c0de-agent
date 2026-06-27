import { css } from '@linaria/core'
import type { ReactNode } from 'react'
import { DESKTOP } from '../styles/breakpoints.js'

const layoutStyle = css`
  display: flex;
  flex-direction: column;
  height: 100dvh;
  width: 100%;
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
  sidebar?: ReactNode
  main: ReactNode
  panel?: ReactNode
}

export function Layout({ sidebar: sidebarNode, main: mainNode, panel: panelNode }: LayoutProps) {
  return (
    <div className={layoutStyle}>
      {sidebarNode && <aside className={sidebarStyle}>{sidebarNode}</aside>}
      <main className={mainStyle}>{mainNode}</main>
      {panelNode && <aside className={panelStyle}>{panelNode}</aside>}
    </div>
  )
}
