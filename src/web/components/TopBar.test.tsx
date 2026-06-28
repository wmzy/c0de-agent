// TopBar 组件测试，对应 src/web/components/TopBar.tsx
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { TopBar } from './TopBar.js'

afterEach(() => cleanup())

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TopBar />
    </MemoryRouter>,
  )
}

/** 项目上下文下渲染 TopBar：需匹配项目路由以让 useParams 解析 projectId。 */
function renderAtProject(projectId: string) {
  return render(
    <MemoryRouter initialEntries={[`/projects/${projectId}`]}>
      <Routes>
        <Route path="/projects/:projectId" element={<TopBar />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('TopBar', () => {
  it('渲染品牌与导航入口', () => {
    renderAt('/')
    expect(screen.getByText('c0de-agent')).toBeTruthy()
    expect(screen.getByText('会话')).toBeTruthy()
    expect(screen.getByText('设置')).toBeTruthy()
  })

  it('设置页可导航（设置链接存在且带 href）', () => {
    renderAt('/')
    const settingsLink = screen.getByText('设置').closest('a')
    expect(settingsLink).toBeTruthy()
    expect(settingsLink?.getAttribute('href')).toBe('/settings')
  })

  it('在设置路由时高亮设置入口', () => {
    renderAt('/settings')
    const settingsLink = screen.getByText('设置').closest('a')
    expect(settingsLink?.getAttribute('data-active')).not.toBeUndefined()
  })

  it('无项目上下文时会话入口指向根路径', () => {
    renderAt('/settings')
    const sessionsLink = screen.getByText('会话').closest('a')
    expect(sessionsLink?.getAttribute('href')).toBe('/')
  })

  it('项目上下文时会话入口指向当前项目路由', () => {
    renderAtProject('abc123')
    const sessionsLink = screen.getByText('会话').closest('a')
    expect(sessionsLink?.getAttribute('href')).toBe('/projects/abc123')
  })
})
