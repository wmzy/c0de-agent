import type { ReactNode } from 'react'
import { css } from '@linaria/core'
import { DESKTOP } from '../styles/breakpoints.js'

const layout = css`
  display: flex;
  flex-direction: column;
  height: 100dvh;
  width: 100%;
  ${DESKTOP} {
    flex-direction: row;
  }
`

const sidebar = css`
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

const main = css`
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
`

const panel = css`
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

export function Layout({ sidebar: sidebarNode, main: mainNode, panel }: LayoutProps) {
  return (
    <div className={layout}>
      {sidebarNode && <aside className={sidebar}>{sidebarNode}</aside>}
      <main className={main}>{mainNode}</main>
      {panel && <aside className={panel}>{panel}</aside>}
    </div>
  )
}
