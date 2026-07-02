import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Layout } from './Layout.js'

afterEach(cleanup)

// Layout 内部渲染 MobileNav，依赖 Router 上下文，故统一包裹 MemoryRouter。
function renderWith(ui: ReactNode) {
  return render(<MemoryRouter initialEntries={['/projects/p1']}>{ui}</MemoryRouter>)
}

function renderThree() {
  return renderWith(
    <Layout
      sidebar={<div data-testid="sb">sidebar</div>}
      main={<div data-testid="mn">main</div>}
      panel={<div data-testid="pn">panel</div>}
    />,
  )
}

describe('Layout 三栏拖拽 resize', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('三栏渲染默认宽度与两条分隔条', () => {
    renderThree()
    expect(screen.getByTestId('layout-sidebar').style.width).toBe('280px')
    expect(screen.getByTestId('layout-panel').style.width).toBe('360px')
    expect(screen.getByTestId('resizer-sidebar')).toBeTruthy()
    expect(screen.getByTestId('resizer-panel')).toBeTruthy()
  })

  it('仅 main 时不渲染分隔条与侧栏', () => {
    renderWith(<Layout main={<div />} />)
    expect(screen.queryByTestId('resizer-sidebar')).toBeNull()
    expect(screen.queryByTestId('resizer-panel')).toBeNull()
    expect(screen.queryByTestId('layout-sidebar')).toBeNull()
    expect(screen.queryByTestId('layout-panel')).toBeNull()
  })

  it('拖拽 sidebar 分隔条向右增大侧栏宽度', () => {
    renderThree()
    const resizer = screen.getByTestId('resizer-sidebar')
    fireEvent.pointerDown(resizer, { clientX: 0 })
    fireEvent.pointerMove(resizer, { clientX: 120 })
    fireEvent.pointerUp(resizer, { clientX: 120 })
    expect(screen.getByTestId('layout-sidebar').style.width).toBe('400px')
  })

  it('拖拽 panel 分隔条向右缩小预览面板宽度', () => {
    renderThree()
    const resizer = screen.getByTestId('resizer-panel')
    fireEvent.pointerDown(resizer, { clientX: 0 })
    fireEvent.pointerMove(resizer, { clientX: 100 })
    fireEvent.pointerUp(resizer, { clientX: 100 })
    expect(screen.getByTestId('layout-panel').style.width).toBe('260px')
  })

  it('侧栏宽度不小于下限 200px', () => {
    renderThree()
    const resizer = screen.getByTestId('resizer-sidebar')
    fireEvent.pointerDown(resizer, { clientX: 0 })
    // 向左拖 999px，远超下限
    fireEvent.pointerMove(resizer, { clientX: -999 })
    fireEvent.pointerUp(resizer, { clientX: -999 })
    expect(screen.getByTestId('layout-sidebar').style.width).toBe('200px')
  })

  it('侧栏宽度不超过上限 480px', () => {
    renderThree()
    const resizer = screen.getByTestId('resizer-sidebar')
    fireEvent.pointerDown(resizer, { clientX: 0 })
    fireEvent.pointerMove(resizer, { clientX: 9999 })
    fireEvent.pointerUp(resizer, { clientX: 9999 })
    expect(screen.getByTestId('layout-sidebar').style.width).toBe('480px')
  })

  it('拖拽后将宽度持久化到 localStorage', () => {
    renderThree()
    const resizer = screen.getByTestId('resizer-sidebar')
    fireEvent.pointerDown(resizer, { clientX: 0 })
    fireEvent.pointerMove(resizer, { clientX: 50 })
    fireEvent.pointerUp(resizer, { clientX: 50 })
    expect(localStorage.getItem('c0de-agent:sidebarWidth')).toBe('330')
  })

  it('初始从 localStorage 读取并钳制到合法区间', () => {
    localStorage.setItem('c0de-agent:sidebarWidth', '420')
    localStorage.setItem('c0de-agent:panelWidth', '9999')
    renderThree()
    expect(screen.getByTestId('layout-sidebar').style.width).toBe('420px')
    expect(screen.getByTestId('layout-panel').style.width).toBe('640px')
  })

  it('双击 sidebar 分隔条恢复默认宽度', () => {
    renderThree()
    const resizer = screen.getByTestId('resizer-sidebar')
    fireEvent.pointerDown(resizer, { clientX: 0 })
    fireEvent.pointerMove(resizer, { clientX: 100 })
    fireEvent.pointerUp(resizer, { clientX: 100 })
    expect(screen.getByTestId('layout-sidebar').style.width).toBe('380px')
    fireEvent.dblClick(resizer)
    expect(screen.getByTestId('layout-sidebar').style.width).toBe('280px')
  })
})
