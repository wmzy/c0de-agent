// useComposer 图片添加：状态更新器内的副作用（校验 + setImageError + readImagePart）
// 在 StrictMode / 并发渲染重放下会执行两次——同一张图被追加两次。
// React 要求更新器是纯函数；此文件锁住「添加图片只产生一个附件」的行为。

import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode, StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useComposer } from '@/composer/useComposer.js'

function strictWrapper({ children }: { children: ReactNode }) {
  return createElement(StrictMode, null, children)
}

function renderComposer() {
  return renderHook(
    () =>
      useComposer({
        onSend: vi.fn(),
        onAbort: vi.fn(),
        onSteer: vi.fn(),
        isStreaming: false,
        hasHistory: false,
        commands: [],
      }),
    { wrapper: strictWrapper },
  )
}

function imageFile(name = 'a.png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
}

/** 等异步 FileReader 完成（readAsDataURL → onload）。 */
async function flushImageRead(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

describe('useComposer 图片添加', () => {
  it('StrictMode 下添加一张图片只产生一个附件（更新器副作用不重复执行）', async () => {
    const { result } = renderComposer()
    act(() => {
      result.current.addImage(imageFile())
    })
    await waitFor(() => {
      expect(result.current.images.length).toBeGreaterThan(0)
    })
    await flushImageRead()
    expect(result.current.images).toHaveLength(1)
    expect(result.current.images[0]?.mediaType).toBe('image/png')
  })

  it('连续添加两张图片累计为两个附件', async () => {
    const { result } = renderComposer()
    act(() => {
      result.current.addImage(imageFile('a.png'))
    })
    await flushImageRead()
    act(() => {
      result.current.addImage(imageFile('b.png'))
    })
    await flushImageRead()
    expect(result.current.images).toHaveLength(2)
  })

  it('超过数量上限的图片被拒绝且给出提示', async () => {
    const { result } = renderComposer()
    for (let i = 0; i < 6; i++) {
      act(() => {
        result.current.addImage(imageFile(`a${i}.png`))
      })
      await flushImageRead()
    }
    expect(result.current.images).toHaveLength(6)
    act(() => {
      result.current.addImage(imageFile('overflow.png'))
    })
    await flushImageRead()
    expect(result.current.images).toHaveLength(6)
    expect(result.current.imageError).toContain('最多添加')
  })
})
