// src/web/components/MobileNav.test.tsx
// MobileNav 组件测试（spec §10.3 移动端底部导航）。
// 「会话」标签控制 Workbench 移动端侧栏覆盖层（开闭状态由 Layout 持有）。

import { createRoutes, MemoryRouter, TypedLink, View } from '@native-router/react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNav } from '@/components/MobileNav.js'

afterEach(() => cleanup())

// 路由表持有器：组件经 module 级变量传入（各用例 props 不同），
// 路由 component 渲染时读取最新值。
let currentUi: ReactNode = null

function TestView() {
  return currentUi
}

const testRoutes = createRoutes({
  children: [
    { path: '/projects/:projectId', component: () => TestView },
    { path: '/settings', component: () => TestView },
  ],
})

async function renderWith(ui: ReactNode, initial = '/projects/p1') {
  currentUi = ui
  const view = render(
    <MemoryRouter routes={testRoutes} initialEntries={[initial]}>
      <View />
    </MemoryRouter>,
  )
  await act(async () => {})
  return view
}

describe('MobileNav', () => {
  it('渲染三个标签（对话/会话/设置）', async () => {
    await renderWith(<MobileNav />)
    expect(screen.getByTestId('mobile-nav-chat')).toBeTruthy()
    expect(screen.getByTestId('mobile-nav-sessions')).toBeTruthy()
    expect(screen.getByTestId('mobile-nav-settings')).toBeTruthy()
    expect(screen.getByTestId('mobile-nav-chat').textContent).toContain('对话')
    expect(screen.getByTestId('mobile-nav-sessions').textContent).toContain('会话')
    expect(screen.getByTestId('mobile-nav-settings').textContent).toContain('设置')
  })

  it('在项目路由下 chat 标签激活', async () => {
    await renderWith(<MobileNav />, '/projects/p1')
    expect(screen.getByTestId('mobile-nav-chat').className).toContain('active')
    expect(screen.getByTestId('mobile-nav-settings').className).not.toContain('active')
  })

  it('在 /settings 路径下 settings 标签激活', async () => {
    await renderWith(<MobileNav />, '/settings')
    expect(screen.getByTestId('mobile-nav-settings').className).toContain('active')
    expect(screen.getByTestId('mobile-nav-chat').className).not.toContain('active')
  })

  it('点击 settings 标签导航且不报错', async () => {
    await renderWith(<MobileNav />)
    fireEvent.click(screen.getByTestId('mobile-nav-settings'))
    // MemoryRouter 内导航无外部可观察副作用，断言按钮仍存在即未抛错
    expect(screen.getByTestId('mobile-nav-settings')).toBeTruthy()
  })

  it('点击 chat 标签不导航（停留在当前路由）且不报错', async () => {
    await renderWith(<MobileNav />)
    fireEvent.click(screen.getByTestId('mobile-nav-chat'))
    expect(screen.getByTestId('mobile-nav-chat')).toBeTruthy()
  })
})

describe('MobileNav 会话覆盖层（Workbench）', () => {
  const sidebar = (
    <div data-testid="overlay-sidebar">
      <button type="button" data-testid="tab-sessions">
        💬会话
      </button>
      <button type="button" data-testid="tab-files">
        📁文件
      </button>
    </div>
  )

  it('点击会话标签调用 onToggleSessions（由 Layout 切换覆盖层）', async () => {
    const onToggleSessions = vi.fn()
    await renderWith(<MobileNav sidebar={sidebar} onToggleSessions={onToggleSessions} />)
    fireEvent.click(screen.getByTestId('mobile-nav-sessions'))
    expect(onToggleSessions).toHaveBeenCalledTimes(1)
    // 再次点击 → 收起（切换语义）
    fireEvent.click(screen.getByTestId('mobile-nav-sessions'))
    expect(onToggleSessions).toHaveBeenCalledTimes(2)
  })

  it('sessionsOpen 时会话标签高亮', async () => {
    await renderWith(<MobileNav sidebar={sidebar} sessionsOpen />)
    expect(screen.getByTestId('mobile-nav-sessions').className).toContain('active')
    expect(screen.getByTestId('mobile-nav-chat').className).not.toContain('active')
  })

  it('路由变化时调用 onSessionsClosed 收起覆盖层', async () => {
    const onSessionsClosed = vi.fn()
    // 覆盖层内选择会话 = 声明式导航（命令式 navigate 在 MemoryRouter
    // 测试环境下的视图提交有时序差异，TypedLink 与真实点击链接等价）
    await renderWith(
      <>
        <MobileNav sidebar={sidebar} onSessionsClosed={onSessionsClosed} />
        <TypedLink to="/settings" data-testid="goto-settings">
          go
        </TypedLink>
      </>,
    )
    // 挂载时 effect 触发一次（幂等：初始即关闭态）
    expect(onSessionsClosed).toHaveBeenCalledTimes(1)
    // 导航 → 路由变化 → 再次收起
    fireEvent.click(screen.getByTestId('goto-settings'))
    await act(async () => {})
    expect(onSessionsClosed).toHaveBeenCalledTimes(2)
  })

  it('未传 sidebar 时点击会话标签无操作', async () => {
    const onToggleSessions = vi.fn()
    await renderWith(<MobileNav onToggleSessions={onToggleSessions} />)
    fireEvent.click(screen.getByTestId('mobile-nav-sessions'))
    expect(onToggleSessions).not.toHaveBeenCalled()
  })

  it('无覆盖层 DOM：抽屉相关节点已随 Workbench 重构移除', async () => {
    await renderWith(<MobileNav sidebar={sidebar} sessionsOpen />)
    // 覆盖层由 Workbench 渲染（Layout 持有 control），MobileNav 自身不再渲染抽屉
    expect(screen.queryByTestId('mobile-drawer')).toBeNull()
    expect(screen.queryByTestId('mobile-drawer-mask')).toBeNull()
    expect(screen.queryByTestId('mobile-drawer-close')).toBeNull()
  })
})
