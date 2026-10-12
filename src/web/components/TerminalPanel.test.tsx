// 终端面板分隔条拖拽的全局状态回归测试。
//
// 分隔条拖拽把全局光标锁成 col-resize/row-resize 并禁用文本选择（都写在
// document.body.style 上）。回归：pointerup 时读的是**当前**值（已是拖拽光标），
// 清空后又把读到的值写回去——拖拽结束后全站光标永久停在 col-resize、文本选择
// 永久禁用，直到刷新或另一次拖拽的清理把残留值当「原值」继续保留。
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalPanel } from '@/components/TerminalPanel.js'
import type { TerminalSession, UseTerminalReturn } from '@/hooks/useTerminal.js'

// xterm 需要真实布局/画布，happy-dom 下不适用：以最小桩替代（本测试只验证
// 拖拽交互对全局样式的副作用，与终端渲染无关）。
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    buffer = {
      active: {
        type: 'normal',
        baseY: 0,
        cursorY: 0,
        length: 0,
        getLine: () => null,
      },
    }
    parser = { registerOscHandler: () => ({ dispose: () => {} }) }
    loadAddon() {}
    open() {}
    write() {}
    focus() {}
    dispose() {}
    getSelection() {
      return ''
    }
    onData() {
      return { dispose: () => {} }
    }
    onResize() {
      return { dispose: () => {} }
    }
    onSelectionChange() {
      return { dispose: () => {} }
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

afterEach(() => {
  cleanup()
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

/** 双 pane 单标签的终端状态桩（分屏时每个 pane 间有一个分隔条）。 */
function makeTerminal(direction: 'horizontal' | 'vertical' = 'horizontal'): UseTerminalReturn {
  const panes: TerminalSession[] = [
    {
      id: 'p1',
      pid: 1,
      title: 'a',
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      shell: '/bin/bash',
      ws: null,
      connecting: false,
      tabId: 't1',
    },
    {
      id: 'p2',
      pid: 2,
      title: 'b',
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      shell: '/bin/bash',
      ws: null,
      connecting: false,
      tabId: 't1',
    },
  ]
  return {
    sessions: panes,
    tabs: [{ id: 't1', panes, split: { direction, sizes: [1, 1] } }],
    activeTabId: 't1',
    activePaneId: 'p1',
    height: 240,
    open: true,
    restoring: false,
    restoreError: null,
    retryRestore: () => {},
    setActiveTabId: () => {},
    setActivePaneId: () => {},
    createTerminal: async () => 'p3',
    splitTerminal: async () => undefined,
    connect: () => {},
    markDead: () => {},
    disconnect: () => {},
    closeTerminal: async () => {},
    resize: async () => {},
    getWebSocket: () => null,
    setSplitDirection: () => {},
    setPaneSizes: () => {},
    toggleOpen: () => {},
    setHeight: () => {},
    minHeight: 100,
    maxHeight: 800,
    minPaneFlex: 0.15,
  }
}

/** 单 pane 双标签的终端状态桩（标签栏键盘导航用）。 */
function makeMultiTabTerminal(): UseTerminalReturn {
  const panes: TerminalSession[] = [
    {
      id: 'p1',
      pid: 1,
      title: 'a',
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      shell: '/bin/zsh',
      ws: null,
      connecting: false,
      tabId: 't1',
    },
    {
      id: 'p2',
      pid: 2,
      title: 'b',
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      shell: '/bin/bash',
      ws: null,
      connecting: false,
      tabId: 't2',
    },
  ]
  return {
    ...makeTerminal(),
    sessions: panes,
    tabs: [
      {
        id: 't1',
        panes: [panes[0] as TerminalSession],
        split: { direction: 'horizontal', sizes: [1] },
      },
      {
        id: 't2',
        panes: [panes[1] as TerminalSession],
        split: { direction: 'horizontal', sizes: [1] },
      },
    ],
    activeTabId: 't1',
    activePaneId: 'p1',
  }
}

describe('TerminalPanel 标签栏的无障碍结构', () => {
  // 回归：关闭按钮此前是 role="tab" 的**后代**（axe nested-interactive serious）——
  // tab 角色要求「选中即切换标签」，却嵌了一个可聚焦按钮；读屏播报的控件名不副实，
  // 且「一个标签 = 一个 Tab 停靠点」的 tablist 约定失效。
  it('关闭按钮不是标签按钮的后代（无嵌套交互控件）', () => {
    render(<TerminalPanel projectId="p1" terminal={makeMultiTabTerminal()} />)
    const tabBtn = screen.getByRole('button', { name: '终端标签 zsh' })
    const closeBtn = screen.getByRole('button', { name: '关闭终端标签 zsh' })

    expect(tabBtn.contains(closeBtn)).toBe(false)
  })

  // 回归：改用 toolbar 后必须仍能表达「当前显示哪个标签」，且方向键可切换。
  // 若退回 role="tab" 而缺少 aria-pressed/aria-selected 语义，选中态会静默丢失。
  it('标签用 aria-pressed 表达选中态，方向键在 toolbar 内切换活动标签', async () => {
    const setActiveTabId = vi.fn()
    render(
      <TerminalPanel projectId="p1" terminal={{ ...makeMultiTabTerminal(), setActiveTabId }} />,
    )
    const [first, second] = screen.getAllByRole('button', { name: /^终端标签 / })

    expect(first?.getAttribute('aria-pressed')).toBe('true')
    expect(second?.getAttribute('aria-pressed')).toBe('false')

    await fireEvent.keyDown(first as HTMLElement, { key: 'ArrowRight' })
    expect(setActiveTabId).toHaveBeenCalledWith('t2')

    await fireEvent.keyDown(first as HTMLElement, { key: 'End' })
    expect(setActiveTabId).toHaveBeenCalledWith('t2')

    await fireEvent.keyDown(first as HTMLElement, { key: 'Home' })
    expect(setActiveTabId).toHaveBeenCalledWith('t1')
  })
})

describe('TerminalPanel 分隔条拖拽的全局光标', () => {
  it('拖拽结束后复原 body 光标与文本选择（不残留 col-resize/user-select:none）', async () => {
    render(<TerminalPanel projectId="p1" terminal={makeTerminal()} />)
    const divider = screen.getByLabelText('调整分屏大小')

    await fireEvent.pointerDown(divider, { clientX: 10, clientY: 10 })
    // 拖拽中：全局光标锁定 + 文本选择禁用
    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.style.userSelect).toBe('none')

    await fireEvent.pointerUp(document)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('拖拽前的既有内联样式被复原（不是被拖拽值覆盖）', async () => {
    document.body.style.cursor = 'wait'
    render(<TerminalPanel projectId="p1" terminal={makeTerminal('vertical')} />)
    const divider = screen.getByLabelText('调整分屏大小')

    await fireEvent.pointerDown(divider, { clientX: 10, clientY: 10 })
    expect(document.body.style.cursor).toBe('row-resize')

    await fireEvent.pointerUp(document)
    expect(document.body.style.cursor).toBe('wait')
    expect(document.body.style.userSelect).toBe('')
  })
})

describe('TerminalPanel 打开面板时自动创建首个终端', () => {
  /** 面板已打开但一个标签都没有的状态（首次打开，或用户刚关掉最后一个标签）。 */
  function emptyTerminal(createTerminal: UseTerminalReturn['createTerminal']): UseTerminalReturn {
    return {
      ...makeTerminal(),
      sessions: [],
      tabs: [],
      activeTabId: null,
      activePaneId: null,
      createTerminal,
    }
  }

  // 回归：重置自动创建标记的 effect 此前是空依赖（`[]`），只在挂载时跑一次，
  // 而挂载时标记本就是 false——等于死代码。实测在项目 A 打开面板自动建过 shell
  // 后切到项目 B，再打开面板只有空区（且写着「终端未连接」），同一个操作在 A
  // 有 shell、在 B 没有；用户以为终端坏了。
  it('切换项目后为新项目重新自动创建', async () => {
    const createTerminal = vi.fn(async () => 'new-pane')
    const terminal = emptyTerminal(createTerminal)
    const { rerender } = render(<TerminalPanel terminal={terminal} cwd="/a" projectId="A" />)
    await waitFor(() => expect(createTerminal).toHaveBeenCalledTimes(1))
    expect(createTerminal).toHaveBeenLastCalledWith({ cwd: '/a' })

    // 同一项目内不重复创建：用户主动关掉最后一个标签后不该被重建。
    rerender(<TerminalPanel terminal={terminal} cwd="/a" projectId="A" />)
    await waitFor(() => expect(createTerminal).toHaveBeenCalledTimes(1))

    // 切到另一个项目：面板打开时同样要建首个终端（用新项目的 cwd）。
    rerender(<TerminalPanel terminal={terminal} cwd="/b" projectId="B" />)
    await waitFor(() => expect(createTerminal).toHaveBeenCalledTimes(2))
    expect(createTerminal).toHaveBeenLastCalledWith({ cwd: '/b' })
  })

  // 切换项目的瞬间 cwd 还是空的（项目查询按 projectId 换 key，新项目数据未到），
  // 此时建终端会落在上一个项目的目录里——必须等 cwd 就绪。
  it('cwd 未就绪时不创建，就绪后补建', async () => {
    const createTerminal = vi.fn(async () => 'new-pane')
    const terminal = emptyTerminal(createTerminal)
    const { rerender } = render(<TerminalPanel terminal={terminal} cwd={undefined} projectId="B" />)
    expect(createTerminal).not.toHaveBeenCalled()

    rerender(<TerminalPanel terminal={terminal} cwd="/b" projectId="B" />)
    await waitFor(() => expect(createTerminal).toHaveBeenCalledTimes(1))
    expect(createTerminal).toHaveBeenLastCalledWith({ cwd: '/b' })
  })
})

// 回归（审查 #5）：projectId 切换后的恢复轮次里，恢复流最后 setSessions(restored)
// 会整体回抹期间新建的会话——前端丢了引用，PTY 在后端成孤儿。空态「新建终端」
// 必须与自动创建同样按 restoring 门控（见上方 effect 的 !open || restoring 早退）。
describe('TerminalPanel 空态「新建终端」的恢复门控', () => {
  /** 恢复进行中/已完成的空终端桩。 */
  function emptyTerminal(
    createTerminal: UseTerminalReturn['createTerminal'],
    restoring: boolean,
  ): UseTerminalReturn {
    return {
      ...makeTerminal(),
      sessions: [],
      tabs: [],
      activeTabId: null,
      activePaneId: null,
      restoring,
      createTerminal,
    }
  }

  it('恢复进行中按钮禁用且点击不创建；恢复完成后（仍无终端）恢复可用', async () => {
    const createTerminal = vi.fn(async () => 'new-pane')
    const { rerender } = render(
      <TerminalPanel terminal={emptyTerminal(createTerminal, true)} cwd="/a" projectId="A" />,
    )

    // 空态按钮（页头还有一个 aria-label 同名的「+」按钮，按文本只命中空态这个）
    const btn = screen.getByText('新建终端').closest('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(createTerminal).not.toHaveBeenCalled()

    // 恢复落地（该项目确无终端）：按钮解除禁用，点击走正常创建
    rerender(
      <TerminalPanel terminal={emptyTerminal(createTerminal, false)} cwd="/a" projectId="A" />,
    )
    const btnAfter = screen.getByText('新建终端').closest('button') as HTMLButtonElement
    expect(btnAfter.disabled).toBe(false)
    const callsBefore = createTerminal.mock.calls.length
    fireEvent.click(btnAfter)
    expect(createTerminal.mock.calls.length).toBe(callsBefore + 1)
    expect(createTerminal).toHaveBeenLastCalledWith({ cwd: '/a' })
  })
})

// pane 连接状态的可见性。
//
// 回归：PTY 已退出或服务端拒绝挂载后，pane 里只剩一屏静止的历史输出，光标停在
// 原地，界面没有任何迹象说明它已经不能输入了——看上去就是一个还活着的终端。
// 同时自动重连 effect 会对着必然失败的连接反复重试（见 useTerminal.test.ts）。
describe('TerminalPanel pane 连接状态', () => {
  /** 最小 WebSocket 桩：只实现 Terminal 桥接用到的事件订阅。 */
  function makeFakeWs() {
    const handlers: ((ev: MessageEvent) => void)[] = []
    return {
      onmessage: null as ((ev: MessageEvent) => void) | null,
      readyState: 1,
      addEventListener(type: string, fn: (ev: MessageEvent) => void) {
        if (type === 'message') handlers.push(fn)
      },
      removeEventListener(_type: string, fn: (ev: MessageEvent) => void) {
        const i = handlers.indexOf(fn)
        if (i >= 0) handlers.splice(i, 1)
      },
      /** 模拟服务端推来一帧数据。 */
      dispatch(data: string) {
        for (const fn of [...handlers]) fn({ data } as MessageEvent)
      },
    }
  }
  /** 单 pane 状态桩，可指定该 pane 的连接状态。 */
  function single(pane: Partial<TerminalSession>, overrides: Partial<UseTerminalReturn> = {}) {
    const full: TerminalSession = {
      id: 'p1',
      pid: 1,
      title: 'a',
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      shell: '/bin/bash',
      ws: null,
      connecting: false,
      tabId: 't1',
      ...pane,
    }
    return {
      ...makeTerminal(),
      sessions: [full],
      tabs: [{ id: 't1', panes: [full], split: { direction: 'horizontal' as const, sizes: [1] } }],
      activeTabId: 't1',
      activePaneId: 'p1',
      ...overrides,
    }
  }

  it('PTY 退出后状态条说明退出码，并给出「新建终端」出口', () => {
    render(<TerminalPanel projectId="p1" terminal={single({ dead: 'exited', exitCode: 130 })} />)

    const status = screen.getByTestId('terminal-pane-status')
    expect(status.textContent).toContain('进程已退出')
    expect(status.textContent).toContain('130')
    expect(within(status).getByRole('button', { name: '新建终端' })).toBeTruthy()
  })

  it('连接被服务端拒绝时说明重连失败（不谎称仍在连接）', () => {
    render(<TerminalPanel projectId="p1" terminal={single({ dead: 'unreachable' })} />)

    expect(screen.getByTestId('terminal-pane-status').textContent).toContain('重连失败')
  })

  it('退避重连期间状态条说明正在连接，不显示成可用终端', () => {
    render(<TerminalPanel projectId="p1" terminal={single({ connecting: true })} />)

    expect(screen.getByTestId('terminal-pane-status').textContent).toContain('正在连接')
  })

  it('连接正常时不显示状态条', () => {
    render(
      <TerminalPanel projectId="p1" terminal={single({ connecting: true, ws: {} as WebSocket })} />,
    )

    expect(screen.queryByTestId('terminal-pane-status')).toBeNull()
  })

  it('已判终态的 pane 不再自动重连（PTY 已不存在，重连必然失败）', () => {
    const connect = vi.fn()
    render(<TerminalPanel projectId="p1" terminal={single({ dead: 'unreachable' }, { connect })} />)

    expect(connect).not.toHaveBeenCalled()
  })

  it('可用的 pane 仍会自动连接', () => {
    const connect = vi.fn()
    render(<TerminalPanel projectId="p1" terminal={single({}, { connect })} />)

    expect(connect).toHaveBeenCalledWith('p1')
  })

  it('退出控制帧把 pane 判为终态（PTY 已退出）', () => {
    const markDead = vi.fn()
    const ws = makeFakeWs()
    render(
      <TerminalPanel
        projectId="p1"
        terminal={single(
          { connecting: false, ws: ws as unknown as WebSocket },
          { markDead, getWebSocket: () => ws as unknown as WebSocket },
        )}
      />,
    )

    ws.dispatch('{"type":"exit","exitCode":0}')

    expect(markDead).toHaveBeenCalledWith('p1', 'exited', 0)
  })

  it('挂载被拒（error 控制帧）把 pane 判为连接失效', () => {
    const markDead = vi.fn()
    const ws = makeFakeWs()
    render(
      <TerminalPanel
        projectId="p1"
        terminal={single(
          { ws: ws as unknown as WebSocket },
          { markDead, getWebSocket: () => ws as unknown as WebSocket },
        )}
      />,
    )

    ws.dispatch('{"type":"error","message":"Terminal not found"}')

    expect(markDead).toHaveBeenCalledWith('p1', 'unreachable')
  })
})
