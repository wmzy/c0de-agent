// 终端面板分隔条拖拽的全局状态回归测试。
//
// 分隔条拖拽把全局光标锁成 col-resize/row-resize 并禁用文本选择（都写在
// document.body.style 上）。回归：pointerup 时读的是**当前**值（已是拖拽光标），
// 清空后又把读到的值写回去——拖拽结束后全站光标永久停在 col-resize、文本选择
// 永久禁用，直到刷新或另一次拖拽的清理把残留值当「原值」继续保留。
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    setActiveTabId: () => {},
    setActivePaneId: () => {},
    createTerminal: async () => 'p3',
    splitTerminal: async () => undefined,
    connect: () => {},
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

describe('TerminalPanel 分隔条拖拽的全局光标', () => {
  it('拖拽结束后复原 body 光标与文本选择（不残留 col-resize/user-select:none）', async () => {
    render(<TerminalPanel terminal={makeTerminal()} />)
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
    render(<TerminalPanel terminal={makeTerminal('vertical')} />)
    const divider = screen.getByLabelText('调整分屏大小')

    await fireEvent.pointerDown(divider, { clientX: 10, clientY: 10 })
    expect(document.body.style.cursor).toBe('row-resize')

    await fireEvent.pointerUp(document)
    expect(document.body.style.cursor).toBe('wait')
    expect(document.body.style.userSelect).toBe('')
  })
})
