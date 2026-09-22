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
