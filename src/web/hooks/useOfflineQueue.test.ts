import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useOfflineQueue } from './useOfflineQueue.js'

describe('useOfflineQueue', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  })

  it('enqueue 写入 localStorage', () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useOfflineQueue(send))
    act(() => result.current.enqueue('hi', 's1'))
    const stored = JSON.parse(localStorage.getItem('c0de-offline-queue') ?? '[]') as Array<{
      message: string
      sessionId: string
    }>
    expect(stored).toHaveLength(1)
    expect(stored[0]?.message).toBe('hi')
  })

  it('在线时自动 flush 并清空', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    localStorage.setItem(
      'c0de-offline-queue',
      JSON.stringify([{ message: 'm', sessionId: 's1', timestamp: 1 }]),
    )
    renderHook(() => useOfflineQueue(send))
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith('s1', 'm')
      expect(JSON.parse(localStorage.getItem('c0de-offline-queue') ?? '[]')).toHaveLength(0)
    })
  })
})
