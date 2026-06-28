// TopBar 组件测试，对应 src/web/components/TopBar.tsx
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
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
})
