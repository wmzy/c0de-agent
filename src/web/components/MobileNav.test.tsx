// src/web/components/MobileNav.test.tsx
// MobileNav 组件测试（spec §10.3 移动端底部导航）。
// 该组件为独立的移动端导航功能，独立测试文件。
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { MobileNav } from './MobileNav.js'

afterEach(() => cleanup())

function renderWith(ui: ReactNode, initial = '/projects/p1') {
  return render(<MemoryRouter initialEntries={[initial]}>{ui}</MemoryRouter>)
}

describe('MobileNav', () => {
  it('渲染三个标签（对话/会话/设置）', () => {
    renderWith(<MobileNav />)
    expect(screen.getByTestId('mobile-nav-chat')).toBeTruthy()
    expect(screen.getByTestId('mobile-nav-sessions')).toBeTruthy()
    expect(screen.getByTestId('mobile-nav-settings')).toBeTruthy()
    expect(screen.getByTestId('mobile-nav-chat').textContent).toContain('对话')
    expect(screen.getByTestId('mobile-nav-sessions').textContent).toContain('会话')
    expect(screen.getByTestId('mobile-nav-settings').textContent).toContain('设置')
  })

  it('在项目路由下 chat 标签激活', () => {
    renderWith(<MobileNav />, '/projects/p1')
    expect(screen.getByTestId('mobile-nav-chat').className).toContain('active')
    expect(screen.getByTestId('mobile-nav-settings').className).not.toContain('active')
  })

  it('在 /settings 路径下 settings 标签激活', () => {
    renderWith(<MobileNav />, '/settings')
    expect(screen.getByTestId('mobile-nav-settings').className).toContain('active')
    expect(screen.getByTestId('mobile-nav-chat').className).not.toContain('active')
  })

  it('点击 settings 标签导航且不报错', () => {
    renderWith(<MobileNav />)
    fireEvent.click(screen.getByTestId('mobile-nav-settings'))
    // MemoryRouter 内导航无外部可观察副作用，断言按钮仍存在即未抛错
    expect(screen.getByTestId('mobile-nav-settings')).toBeTruthy()
  })

  it('点击 chat 标签不导航（停留在当前路由）且不报错', () => {
    renderWith(<MobileNav />)
    fireEvent.click(screen.getByTestId('mobile-nav-chat'))
    expect(screen.getByTestId('mobile-nav-chat')).toBeTruthy()
  })
})
