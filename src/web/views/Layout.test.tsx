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

// 拖拽：pointerdown 设 dragging=true → useEffect 向 document 挂载 pointermove/up 监听。
// fireEvent 是异步的（包在 act 中），await 之间保证 effect 已挂载、state 已提交，
// 从而 document 级监听能收到后续冒泡到 document 的 pointer 事件。
async function drag(resizer: HTMLElement, fromX: number, toX: number) {
  await fireEvent.pointerDown(resizer, { clientX: fromX })
  await fireEvent.pointerMove(resizer, { clientX: toX })
  await fireEvent.pointerUp(resizer, { clientX: toX })
}

describe('Layout 三栏拖拽 resize', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('三栏渲染默认宽度与两条分隔条', () => {
    renderThree()
    expect(screen.getByTestId('layout-sidebar').style.width).toBe('280px')
    // 预览面板默认宽度自适应视口：max(480, min(45vw, 720))；jsdom innerWidth=1024 → 480
    expect(screen.getByTestId('layout-panel').style.width).toBe('480px')
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

  it('拖拽 sidebar 分隔条向右增大侧栏宽度', async () => {
    renderThree()
    const resizer = screen.getByTestId('resizer-sidebar')
    await drag(resizer, 0, 120)
    expect(screen.getByTestId('layout-sidebar').style.width).toBe('400px')
  })

  it('拖拽 panel 分隔条向右缩小预览面板宽度', async () => {
    renderThree()
    const resizer = screen.getByTestId('resizer-panel')
    await drag(resizer, 0, 100)
    // 默认宽度随视口自适应（jsdom 1024px 视口 → 480px），拖拽后 480-100=380
    expect(screen.getByTestId('layout-panel').style.width).toBe('380px')
  })

  it('侧栏宽度不小于下限 200px', async () => {
    renderThree()
    const resizer = screen.getByTestId('resizer-sidebar')
    await drag(resizer, 0, -999)
    expect(screen.getByTestId('layout-sidebar').style.width).toBe('200px')
  })

  it('侧栏宽度不超过上限 480px', async () => {
    renderThree()
    const resizer = screen.getByTestId('resizer-sidebar')
    await drag(resizer, 0, 9999)
    expect(screen.getByTestId('layout-sidebar').style.width).toBe('480px')
  })

  it('拖拽后将宽度持久化到 localStorage', async () => {
    renderThree()
    const resizer = screen.getByTestId('resizer-sidebar')
    await drag(resizer, 0, 50)
    expect(localStorage.getItem('c0de-agent:sidebarWidth')).toBe('330')
  })

  it('初始从 localStorage 读取并钳制到合法区间', () => {
    localStorage.setItem('c0de-agent:sidebarWidth', '420')
    localStorage.setItem('c0de-agent:panelWidth', '9999')
    renderThree()
    expect(screen.getByTestId('layout-sidebar').style.width).toBe('420px')
    expect(screen.getByTestId('layout-panel').style.width).toBe('960px')
  })

  it('双击 sidebar 分隔条恢复默认宽度', async () => {
    renderThree()
    const resizer = screen.getByTestId('resizer-sidebar')
    await drag(resizer, 0, 100)
    expect(screen.getByTestId('layout-sidebar').style.width).toBe('380px')
    fireEvent.dblClick(resizer)
    expect(screen.getByTestId('layout-sidebar').style.width).toBe('280px')
  })

  it('快速拖拽超出分隔条范围仍能收到移动事件（document 级监听）', async () => {
    // 关键回归：光标移出 1px 分隔条后事件仍被 document 监听捕获，宽度持续变化。
    renderThree()
    const resizer = screen.getByTestId('resizer-sidebar')
    await fireEvent.pointerDown(resizer, { clientX: 0 })
    // pointermove 派发到 document（模拟光标已离开 resizer），而非 resizer 本身
    await fireEvent.pointerMove(document, { clientX: 90 })
    await fireEvent.pointerMove(document, { clientX: 200 })
    await fireEvent.pointerUp(document, { clientX: 200 })
    expect(screen.getByTestId('layout-sidebar').style.width).toBe('480px')
  })
})
