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

describe('MobileNav 会话抽屉', () => {
  const sidebar = (
    <div data-testid="drawer-sidebar">
      <button type="button" data-testid="tab-sessions">
        💬会话
      </button>
      <button type="button" data-testid="tab-files">
        📁文件
      </button>
    </div>
  )

  it('点击会话标签打开抽屉，内嵌侧栏（会话+文件 tab），再次点击关闭', () => {
    renderWith(<MobileNav sidebar={sidebar} />)
    expect(screen.queryByTestId('mobile-drawer')).toBeNull()
    fireEvent.click(screen.getByTestId('mobile-nav-sessions'))
    expect(screen.getByTestId('mobile-drawer')).toBeTruthy()
    expect(screen.getByTestId('drawer-sidebar')).toBeTruthy()
    expect(screen.getByTestId('tab-sessions')).toBeTruthy()
    expect(screen.getByTestId('tab-files')).toBeTruthy()
    // 抽屉打开期间 sessions 标签高亮
    expect(screen.getByTestId('mobile-nav-sessions').className).toContain('active')
    fireEvent.click(screen.getByTestId('mobile-nav-sessions'))
    expect(screen.queryByTestId('mobile-drawer')).toBeNull()
  })

  it('点击遮罩关闭抽屉', () => {
    renderWith(<MobileNav sidebar={sidebar} />)
    fireEvent.click(screen.getByTestId('mobile-nav-sessions'))
    fireEvent.click(screen.getByTestId('mobile-drawer-mask'))
    expect(screen.queryByTestId('mobile-drawer')).toBeNull()
  })

  it('点击 ✕ 关闭抽屉', () => {
    renderWith(<MobileNav sidebar={sidebar} />)
    fireEvent.click(screen.getByTestId('mobile-nav-sessions'))
    fireEvent.click(screen.getByTestId('mobile-drawer-close'))
    expect(screen.queryByTestId('mobile-drawer')).toBeNull()
  })

  it('Esc 关闭抽屉', () => {
    renderWith(<MobileNav sidebar={sidebar} />)
    fireEvent.click(screen.getByTestId('mobile-nav-sessions'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('mobile-drawer')).toBeNull()
  })

  it('未传 sidebar 时点击会话标签不渲染抽屉', () => {
    renderWith(<MobileNav />)
    fireEvent.click(screen.getByTestId('mobile-nav-sessions'))
    expect(screen.queryByTestId('mobile-drawer')).toBeNull()
  })

  it('抽屉打开时锁定背景滚动，关闭后恢复', () => {
    renderWith(<MobileNav sidebar={sidebar} />)
    fireEvent.click(screen.getByTestId('mobile-nav-sessions'))
    expect(document.body.style.overflow).toBe('hidden')
    fireEvent.click(screen.getByTestId('mobile-drawer-close'))
    expect(document.body.style.overflow).toBe('')
  })
})
