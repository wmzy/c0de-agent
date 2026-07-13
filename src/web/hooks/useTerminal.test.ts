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

import { useTerminal } from './useTerminal.js'

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
