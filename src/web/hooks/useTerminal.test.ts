// src/web/hooks/useTerminal.test.ts
// 来源：终端按项目隔离需求。终端 hook 此前无测试文件，故新建。

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreate = vi.fn()
const mockList = vi.fn()
const mockKill = vi.fn()
vi.mock('../services/terminal.js', () => ({
  terminalAPI: {
    list: () => mockList(),
    create: (params?: object) => mockCreate(params),
    get: vi.fn(),
    resize: vi.fn(),
    kill: (id: string) => mockKill(id),
  },
  terminalWsUrl: (id: string) => `ws://localhost/${id}`,
}))

import { reconcileSizes } from '@/hooks/terminal-persistence.js'
import { useTerminal } from '@/hooks/useTerminal.js'

function fakeInfo(id: string, projectId?: string) {
  return {
    id,
    pid: 1,
    title: 'sh',
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    shell: '/bin/bash',
    ...(projectId !== undefined ? { projectId } : {}),
  }
}

/** 向 localStorage 写入某项目的终端布局。 */
function seedLayout(projectId: string, sessionIds: string[]) {
  const sessions = sessionIds.map((id) => ({ id, tabId: id }))
  const tabSplits: Record<string, { direction: 'horizontal'; sizes: number[] }> = {}
  for (const id of sessionIds) tabSplits[id] = { direction: 'horizontal', sizes: [1] }
  localStorage.setItem(
    `c0de-agent:terminalSessions:${projectId}`,
    JSON.stringify({
      sessions,
      tabSplits,
      activeTabId: sessionIds[0] ?? null,
      activePaneId: sessionIds[0] ?? null,
    }),
  )
}

beforeEach(() => {
  localStorage.clear()
  mockCreate.mockReset()
  mockList.mockReset()
  mockKill.mockReset()
  mockList.mockResolvedValue({ terminals: [] })
})

afterEach(() => {
  localStorage.clear()
})

describe('useTerminal 项目隔离', () => {
  it('createTerminal 将 projectId 传给后端', async () => {
    mockCreate.mockResolvedValue(fakeInfo('pty_1', 'projA'))
    const { result } = renderHook(() => useTerminal('projA'))

    // 等待 mount 恢复完成（无 localStorage，立即完成）
    await act(async () => {})

    await act(async () => {
      await result.current.createTerminal({ cwd: '/tmp' })
    })

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'projA', cwd: '/tmp' }),
    )
  })

  it('后端 projectId 为权威：localStorage 含 pty_A 但后端归属 projA，切到 projB 不恢复', async () => {
    // projB 的 localStorage 误含 pty_A（模拟脏数据/多标签页串扰）
    seedLayout('projB', ['pty_A'])
    // 后端说 pty_A 属于 projA
    mockList.mockResolvedValue({ terminals: [fakeInfo('pty_A', 'projA')] })

    const { result } = renderHook(() => useTerminal('projB'))
    await act(async () => {})

    // projB localStorage 有 pty_A，但后端归属是 projA → 不恢复
    expect(result.current.sessions).toHaveLength(0)
    expect(result.current.restoring).toBe(false)
  })

  it('切到另一项目再切回，恢复原项目终端', async () => {
    seedLayout('projA', ['pty_A'])
    mockList.mockResolvedValue({ terminals: [fakeInfo('pty_A', 'projA')] })

    const { result, rerender } = renderHook(({ pid }) => useTerminal(pid), {
      initialProps: { pid: 'projA' },
    })
    await act(async () => {})
    expect(result.current.sessions).toHaveLength(1)

    // 切到 projB（无终端）
    rerender({ pid: 'projB' })
    await act(async () => {})
    expect(result.current.sessions).toHaveLength(0)

    // 切回 projA
    rerender({ pid: 'projA' })
    await act(async () => {})

    expect(result.current.sessions).toHaveLength(1)
    expect(result.current.sessions[0]?.id).toBe('pty_A')
    expect(result.current.sessions[0]?.projectId).toBe('projA')
  })

  it('切到无终端记录的项目 open 为 false', async () => {
    const { result } = renderHook(() => useTerminal('newProj'))
    await act(async () => {})
    expect(result.current.open).toBe(false)
  })
})

describe('分屏布局变更必须反映到 tabs（渲染输入）', () => {
  it('setPaneSizes 后 tabs[].split.sizes 立即更新', async () => {
    mockCreate
      .mockResolvedValueOnce(fakeInfo('pty_1', 'projA'))
      .mockResolvedValueOnce(fakeInfo('pty_2', 'projA'))
    const { result } = renderHook(() => useTerminal('projA'))
    await act(async () => {})

    await act(async () => {
      await result.current.createTerminal()
    })
    await act(async () => {
      await result.current.splitTerminal()
    })

    const tabId = result.current.tabs[0]?.id
    expect(tabId).toBeTruthy()
    expect(result.current.tabs[0]?.panes).toHaveLength(2)

    act(() => {
      result.current.setPaneSizes(tabId as string, [3, 1])
    })

    const sizes = result.current.tabs[0]?.split.sizes ?? []
    expect(sizes).toHaveLength(2)
    expect((sizes[0] ?? 0) / (sizes[1] ?? 1)).toBeCloseTo(3, 6)
  })

  it('setSplitDirection 后 tabs[].split.direction 立即更新', async () => {
    mockCreate.mockResolvedValueOnce(fakeInfo('pty_1', 'projA'))
    const { result } = renderHook(() => useTerminal('projA'))
    await act(async () => {})

    await act(async () => {
      await result.current.createTerminal()
    })
    const tabId = result.current.tabs[0]?.id as string

    act(() => {
      result.current.setSplitDirection(tabId, 'vertical')
    })

    expect(result.current.tabs[0]?.split.direction).toBe('vertical')
  })
})

// 复现：reconcileSizes 是「持久化 sizes → 渲染 flexGrow」的唯一收敛点，但它只处理
// 长度不一致与 sum <= 0，对非有限值/负值原样透传：NaN 的 sum 比较恒为 false，
// 归一化产出 NaN；负值产出负 flexGrow。PaneSplitContainer 的 flexGrow: NaN /
// -2 是非法 CSS（声明被丢弃 → flex-grow 回落 0，而 flexBasis 为 0）→ 分屏 pane
// 宽度塌成 0 且**拖拽无法恢复**（拖拽算式同样以 NaN 为输入）。持久化数据来自
// localStorage（旧版本遗留/手工编辑/容器 rect 为 0 时的 Infinity 增量）。
describe('终端分屏 sizes 归一化不变量', () => {
  const invariant = (sizes: number[], count: number): number[] => {
    const out = reconcileSizes(sizes, count)
    expect(out).toHaveLength(count)
    for (const v of out) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
    }
    // 归一化后均值 1.0（总和 = pane 数）
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(count, 6)
    return out
  }

  it('NaN 与 Infinity 收敛为有限正值（不再产出 NaN flexGrow）', () => {
    invariant([Number.NaN], 1)
    invariant([Number.NaN, 2], 2)
    invariant([Number.POSITIVE_INFINITY, 1], 2)
    invariant([Number.NEGATIVE_INFINITY, 1], 2)
  })

  it('负值收敛为正值（不再产出负 flexGrow）', () => {
    invariant([-1, 2], 2)
    invariant([-5, -5], 2)
  })

  it('合法 sizes 保持相对比例（不误伤正常拖拽结果）', () => {
    const out = invariant([3, 1], 2)
    const [first = 0, second = 0] = out
    expect(first / second).toBeCloseTo(3, 6)
  })

  it('持久化 sizes 含非法项时渲染出的 pane 尺寸仍有限（端到端）', async () => {
    // JSON 落盘的非法形态：NaN → null；字符串数字 → 字符串（旧版本/手工编辑）。
    // [null, 2] 归一化后为 [0, 2]（0 flexGrow → pane 塌成 0 宽）；
    // ['2','1'] 的 sum 是字符串拼接 "021"，归一化产出 NaN。
    for (const [projectId, sizes] of [
      ['projNull', [null, 2]],
      ['projStr', ['2', '1']],
    ] as const) {
      localStorage.setItem(
        `c0de-agent:terminalSessions:${projectId}`,
        JSON.stringify({
          sessions: [
            { id: `${projectId}_a`, tabId: `${projectId}_t` },
            { id: `${projectId}_b`, tabId: `${projectId}_t` },
          ],
          tabSplits: { [`${projectId}_t`]: { direction: 'horizontal', sizes } },
          activeTabId: `${projectId}_t`,
          activePaneId: `${projectId}_a`,
        }),
      )
      mockList.mockResolvedValue({
        terminals: [fakeInfo(`${projectId}_a`, projectId), fakeInfo(`${projectId}_b`, projectId)],
      })

      const { result, unmount } = renderHook(() => useTerminal(projectId))
      await act(async () => {})

      const rendered = result.current.tabs[0]?.split.sizes ?? []
      expect(rendered, projectId).toHaveLength(2)
      for (const v of rendered) {
        expect(Number.isFinite(v), `${projectId}: ${JSON.stringify(rendered)}`).toBe(true)
        expect(v, `${projectId}: ${JSON.stringify(rendered)}`).toBeGreaterThan(0)
      }
      unmount()
      localStorage.clear()
    }
  })
})

// 断线重连的终态判停。
//
// 回归：PTY 退出后 pty-manager 删除条目并关掉所有 socket，服务端对后续挂载一律回
// 「Terminal not found」+ close(1008)；而前端 onclose 只是把 session 置回
// {ws:null, connecting:false}——TerminalPanel 的自动重连 effect 依赖整个 tabs
// 对象，sessions 每变一次它就重跑一次，于是「关掉 → 重连 → 被拒 → 关掉」无延迟
// 成环：服务端被持续 WS upgrade，pane 永远黑屏且没有任何提示（PTY 明明已经
// 不存在了，重连永远不会成功）。
describe('终端断线后的重连节奏', () => {
  class FakeSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 3
    static instances: FakeSocket[] = []
    readyState = FakeSocket.CONNECTING
    onopen: (() => void) | null = null
    onclose: ((ev: { code: number }) => void) | null = null
    onerror: (() => void) | null = null
    onmessage: ((ev: MessageEvent) => void) | null = null
    closedByCaller = 0
    constructor() {
      FakeSocket.instances.push(this)
    }
    close() {
      this.closedByCaller += 1
    }
    /** 模拟握手成功。 */
    open() {
      this.readyState = FakeSocket.OPEN
      this.onopen?.()
    }
    /** 模拟异常断开（浏览器在连接失败后必定补 close 事件，code 才是判据）。 */
    drop(code = 1006) {
      this.readyState = FakeSocket.CLOSED
      this.onclose?.({ code })
    }
  }

  const realWebSocket = globalThis.WebSocket
  const last = () => FakeSocket.instances[FakeSocket.instances.length - 1] as FakeSocket

  /** 建一个终端并连上（返回第一个 socket）。 */
  async function connected() {
    mockCreate.mockResolvedValue(fakeInfo('pty_1', 'projA'))
    const hook = renderHook(() => useTerminal('projA'))
    await act(async () => {})
    await act(async () => {
      await hook.result.current.createTerminal({ cwd: '/tmp' })
    })
    await act(async () => {
      hook.result.current.connect('pty_1')
    })
    await act(async () => {
      last().open()
    })
    return hook
  }

  beforeEach(() => {
    FakeSocket.instances = []
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.stubGlobal('WebSocket', realWebSocket)
  })

  it('服务端拒绝挂载（Terminal not found / 1008）后判停，不再反复重连', async () => {
    const { result } = await connected()
    expect(FakeSocket.instances).toHaveLength(1)

    await act(async () => {
      last().drop(1008)
    })

    expect(result.current.sessions[0]?.dead).toBe('unreachable')
    // 再怎么自动重连也不会有新 socket。
    await act(async () => {
      result.current.connect('pty_1')
      vi.advanceTimersByTime(60_000)
    })
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('PTY 退出（markDead exited）后判停，退避中的重试被取消', async () => {
    const { result } = await connected()

    // 网络抖动：进入退避重连（重连计时器已排上）
    await act(async () => {
      last().drop()
    })
    await act(async () => {
      result.current.markDead('pty_1', 'exited', 0)
    })

    expect(result.current.sessions[0]?.dead).toBe('exited')
    expect(result.current.sessions[0]?.exitCode).toBe(0)
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('退避窗口内不接受抢跑重连（自动重连 effect 每次渲染都会调用 connect）', async () => {
    const { result } = await connected()

    await act(async () => {
      last().drop()
    })
    await act(async () => {
      result.current.connect('pty_1')
      result.current.connect('pty_1')
    })

    expect(FakeSocket.instances).toHaveLength(1)
    // 退避到期后由定时器自己重连一次。
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('连上就断的抖动链路退避会逐级拉长，次数耗尽后判死（不会无限打服务端）', async () => {
    const { result } = await connected()

    // 每次都「刚连上就断」：退避不得被打回第一档，重连次数必须有上限。
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        vi.advanceTimersByTime(30_000)
      })
      const socket = FakeSocket.instances[FakeSocket.instances.length - 1]
      if (!socket || result.current.sessions[0]?.dead) break
      await act(async () => {
        socket.open()
        socket.drop()
      })
    }

    expect(result.current.sessions[0]?.dead).toBe('unreachable')
    expect(FakeSocket.instances.length).toBeLessThanOrEqual(1 + 6 + 1)
    const count = FakeSocket.instances.length
    await act(async () => {
      vi.advanceTimersByTime(600_000)
    })
    expect(FakeSocket.instances).toHaveLength(count)
  })

  it('主动 disconnect 不触发重连（PTY 仍在，重连由打开面板时驱动）', async () => {
    const { result } = await connected()

    await act(async () => {
      result.current.disconnect('pty_1')
    })
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })

    expect(FakeSocket.instances).toHaveLength(1)
    expect(result.current.sessions[0]?.dead).toBeUndefined()
  })

  it('连稳过的连接断开后退避计数清零（下一次断线重新从第一档算）', async () => {
    const { result } = await connected()

    // 先抖动一次（退避拉到 500ms 档），重连成功并稳定运行 5 秒以上。
    await act(async () => {
      last().drop()
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await act(async () => {
      last().open()
    })
    expect(result.current.sessions[0]?.ws).toBeTruthy()
    await act(async () => {
      vi.advanceTimersByTime(6_000)
    })

    // 稳定后的下一次断线：第一次重试回到 500ms 档（不是继续拉长）。
    await act(async () => {
      last().drop()
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(FakeSocket.instances).toHaveLength(3)
  })
})

// 复现：切项目/挂载恢复时 terminalAPI.list() 一旦失败（后端 500、DB 被占、网络
// 抖动），catch 空吞 → finally setRestoring(false) → 持久化 effect 拿着被清空的
// sessions=[] 回写 localStorage，把该项目还完好的终端布局永久覆盖掉；仍在后端
// 存活的 PTY 从此没有任何入口。用户看到的是「尚无终端」这句谎话。
describe('终端恢复失败不得抹掉磁盘上的布局', () => {
  it('list 失败：如实报错，且不把空布局写回 localStorage', async () => {
    seedLayout('projA', ['pty_A', 'pty_B'])
    mockList.mockRejectedValueOnce(new Error('db is locked'))

    const { result } = renderHook(() => useTerminal('projA'))
    await act(async () => {})
    await act(async () => {})

    expect(result.current.restoreError).toBeTruthy()
    const raw = localStorage.getItem('c0de-agent:terminalSessions:projA')
    const parsed = JSON.parse(raw ?? '{}') as { sessions?: unknown[] }
    expect(parsed.sessions).toHaveLength(2)
  })

  it('重试成功后布局恢复、错误清除，磁盘内容仍完整', async () => {
    seedLayout('projA', ['pty_A', 'pty_B'])
    mockList.mockRejectedValueOnce(new Error('db is locked'))

    const { result } = renderHook(() => useTerminal('projA'))
    await act(async () => {})
    await act(async () => {})
    expect(result.current.restoreError).toBeTruthy()

    mockList.mockResolvedValueOnce({
      terminals: [fakeInfo('pty_A', 'projA'), fakeInfo('pty_B', 'projA')],
    })
    await act(async () => {
      result.current.retryRestore()
    })
    await act(async () => {})

    expect(result.current.restoreError).toBeNull()
    expect(result.current.sessions).toHaveLength(2)
    const parsed = JSON.parse(
      localStorage.getItem('c0de-agent:terminalSessions:projA') ?? '{}',
    ) as { sessions?: unknown[] }
    expect(parsed.sessions).toHaveLength(2)
  })
})

/**
 * 回归：新建终端 / 分屏失败此前完全静默。
 *
 * terminalAPI.create 的 rejection 直接甩给调用方，而 TerminalPanel 一律 `void`
 * 掉返回值：PTY 建不出来时界面纹丝不动（顺带一条 unhandledrejection），用户只会
 * 以为「+」和分屏按钮坏了。
 */
describe('useTerminal 新建/分屏失败', () => {
  it('createTerminal 失败：留下原因、不抛异常、不建出会话', async () => {
    mockCreate.mockRejectedValue(new Error('PTY 启动失败：no such shell'))
    const { result } = renderHook(() => useTerminal('projA'))
    await act(async () => {})

    let returned: string | undefined = 'unset'
    await act(async () => {
      returned = await result.current.createTerminal({ cwd: '/tmp' })
    })

    expect(returned).toBeUndefined()
    expect(result.current.sessions).toHaveLength(0)
    expect(result.current.createError).toBe('新建终端失败：PTY 启动失败：no such shell')
  })

  it('splitTerminal 失败：同样给出原因，不改布局', async () => {
    mockList.mockResolvedValue({ terminals: [fakeInfo('pty_A', 'projA')] })
    seedLayout('projA', ['pty_A'])
    mockCreate.mockRejectedValue(new Error('PTY 启动失败：too many processes'))
    const { result } = renderHook(() => useTerminal('projA'))
    await act(async () => {})
    expect(result.current.sessions).toHaveLength(1)
    const before = result.current.tabs[0]?.split.sizes

    await act(async () => {
      await result.current.splitTerminal({ direction: 'horizontal' })
    })

    expect(result.current.tabs[0]?.split.sizes).toEqual(before)
    expect(result.current.createError).toBe('分屏失败：PTY 启动失败：too many processes')
  })

  it('重试成功清掉失败原因', async () => {
    mockCreate.mockRejectedValueOnce(new Error('PTY 启动失败：boom'))
    mockCreate.mockResolvedValueOnce(fakeInfo('pty_1', 'projA'))
    const { result } = renderHook(() => useTerminal('projA'))
    await act(async () => {})

    await act(async () => {
      await result.current.createTerminal({ cwd: '/tmp' })
    })
    expect(result.current.createError).toContain('boom')

    await act(async () => {
      await result.current.createTerminal({ cwd: '/tmp' })
    })

    expect(result.current.createError).toBeNull()
    expect(result.current.sessions).toHaveLength(1)
  })
})
