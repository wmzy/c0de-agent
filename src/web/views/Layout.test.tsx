import { createRoutes, MemoryRouter, View } from '@native-router/react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Layout } from '@/views/Layout.js'

afterEach(cleanup)

// Layout 内部渲染 MobileNav，依赖 Router 上下文，故统一包裹 MemoryRouter。
// 路由表持有器：Layout 经 module 级变量传入，路由 component 渲染时读取最新值。
let currentUi: ReactNode = null

function TestView() {
  return currentUi
}

const testRoutes = createRoutes({
  children: [{ path: '/projects/:projectId', component: () => TestView }],
})

async function renderWith(ui: ReactNode) {
  currentUi = ui
  const view = render(
    <MemoryRouter routes={testRoutes} initialEntries={['/projects/p1']}>
      <View />
    </MemoryRouter>,
  )
  await act(async () => {})
  return view
}

async function renderThree() {
  return renderWith(
    <Layout
      sidebar={<div data-testid="sb">sidebar</div>}
      main={<div data-testid="mn">main</div>}
      panel={<div data-testid="pn">panel</div>}
    />,
  )
}

// Workbench（haze-ui）内置 Resizable：列宽体现在 ResizablePanel 的
// flexBasis，分隔条是 role="separator" 的 handle（data-slot 定位）。
function panelBy(id: string): HTMLElement {
  return document.querySelector(`[data-panel-id="${id}"]`) as HTMLElement
}

function handles(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="resizable-handle"]')]
}

function handleAt(index: number): HTMLElement {
  const handle = handles()[index]
  if (!handle) {
    throw new Error(`resizable handle #${index} not found`)
  }
  return handle
}

// 拖拽：pointerdown 记录起点 → pointermove 计算增量并应用 →
// pointerup 提交（Workbench onResizeCommit 回写 control → 持久化）。
async function drag(handle: HTMLElement, fromX: number, toX: number) {
  await fireEvent.pointerDown(handle, { clientX: fromX })
  await fireEvent.pointerMove(handle, { clientX: toX })
  await fireEvent.pointerUp(handle, { clientX: toX })
}

describe('Layout 三栏拖拽 resize（Workbench）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('三栏渲染默认宽度与两条分隔条', async () => {
    await renderThree()
    expect(panelBy('sidebar').style.flexBasis).toBe('280px')
    // 预览面板默认 480（Workbench 约束上限 480）
    expect(panelBy('auxiliary').style.flexBasis).toBe('480px')
    // 两条分隔条：侧栏后 + 辅助列前
    expect(handles()).toHaveLength(2)
    expect(handles().every((h) => h.getAttribute('role') === 'separator')).toBe(true)
    expect(screen.getByTestId('sb')).toBeTruthy()
    expect(screen.getByTestId('mn')).toBeTruthy()
    expect(screen.getByTestId('pn')).toBeTruthy()
  })

  it('仅 main 时不渲染分隔条与侧栏', async () => {
    await renderWith(<Layout main={<div />} />)
    expect(handles()).toHaveLength(0)
    expect(panelBy('sidebar')).toBeNull()
    expect(panelBy('auxiliary')).toBeNull()
  })

  it('拖拽 sidebar 分隔条向右增大侧栏宽度', async () => {
    await renderThree()
    await drag(handleAt(0), 0, 120)
    expect(panelBy('sidebar').style.flexBasis).toBe('400px')
  })

  it('拖拽 panel 分隔条向右缩小预览面板宽度', async () => {
    await renderThree()
    await drag(handleAt(1), 0, 100)
    // 默认 480，拖拽右移 100 → 辅助列缩小 100
    expect(panelBy('auxiliary').style.flexBasis).toBe('380px')
  })

  it('侧栏宽度不小于 Workbench 硬下限 160px', async () => {
    await renderThree()
    await drag(handleAt(0), 0, -999)
    expect(panelBy('sidebar').style.flexBasis).toBe('160px')
  })

  it('侧栏宽度不超过上限 480px', async () => {
    await renderThree()
    await drag(handleAt(0), 0, 9999)
    expect(panelBy('sidebar').style.flexBasis).toBe('480px')
  })

  it('拖拽后将宽度持久化到 localStorage', async () => {
    await renderThree()
    await drag(handleAt(0), 0, 50)
    expect(localStorage.getItem('c0de-agent:sidebarWidth')).toBe('330')
  })

  it('初始从 localStorage 读取并钳制到合法区间', async () => {
    localStorage.setItem('c0de-agent:sidebarWidth', '420')
    localStorage.setItem('c0de-agent:panelWidth', '9999')
    await renderThree()
    expect(panelBy('sidebar').style.flexBasis).toBe('420px')
    // 预览面板上限 480（Workbench 约束）
    expect(panelBy('auxiliary').style.flexBasis).toBe('480px')
  })

  it('双击 sidebar 分隔条不报错（受控语义：恢复当前控制值）', async () => {
    await renderThree()
    await drag(handleAt(0), 0, 100)
    expect(panelBy('sidebar').style.flexBasis).toBe('380px')
    // Workbench 受控 control 下，双击恢复的是当前控制值（拖拽已提交），
    // 此处锁定「双击不抛错」契约；恢复初始宽度由持久化值重启会话生效。
    fireEvent.dblClick(handleAt(0))
    expect(panelBy('sidebar').style.flexBasis).toBe('380px')
  })

  it('移动端侧栏覆盖层经 tabBar 渲染 MobileNav', async () => {
    await renderThree()
    // Workbench 的 tabBar 槽仅在移动端媒体查询下可见，
    // jsdom 无媒体查询求值——DOM 层面 nav 节点存在即可。
    expect(screen.getByTestId('mobile-nav')).toBeTruthy()
    expect(screen.getByTestId('mobile-nav-sessions')).toBeTruthy()
  })
})
