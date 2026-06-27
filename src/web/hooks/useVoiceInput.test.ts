import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVoiceInput } from './useVoiceInput.js'

describe('useVoiceInput', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('无 API 时 start 不报错', () => {
    const { result } = renderHook(() => useVoiceInput())
    act(() => result.current.start())
    expect(result.current.listening).toBe(false)
  })

  it('有 webkitSpeechRecognition 时启动', () => {
    const fakeRec = {
      continuous: false,
      interimResults: false,
      lang: '',
      start: vi.fn(),
      stop: vi.fn(),
      onresult: null as unknown,
      onerror: null as unknown,
    }
    vi.stubGlobal(
      'webkitSpeechRecognition',
      vi.fn(() => fakeRec),
    )
    const { result } = renderHook(() => useVoiceInput())
    act(() => result.current.start())
    expect(fakeRec.start).toHaveBeenCalled()
    expect(result.current.listening).toBe(true)
  })
})
