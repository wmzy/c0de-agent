// useComposer 图片添加：状态更新器内的副作用（校验 + setImageError + readImagePart）
// 在 StrictMode / 并发渲染重放下会执行两次——同一张图被追加两次。
// React 要求更新器是纯函数；此文件锁住「添加图片只产生一个附件」的行为。

import { act, renderHook, waitFor } from '@testing-library/react'
import {
  createElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  StrictMode,
} from 'react'
import { describe, expect, it, vi } from 'vitest'
import { saveHistory } from '@/composer/history.js'
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

// ── pill 保留回归 ──
// popover 插入（@文件/@agent）与外部引用追加此前把 prompt 从平铺文本重建：
// 既有 file/snippet/terminal pill 被降级为纯文本——发送时 files 附件丢失、
// snippet/terminal 内容不再注入消息。此文件锁住「引用操作不吞既有 pill」。

import type { ImagePart } from '@/composer/types.js'
import { promptToText } from '@/composer/types.js'

type PillInsertResult = {
  promptRef: { current: { map: (fn: (p: { type: string }) => unknown) => unknown[] } }
  insertFile: (path: string) => void
  appendFileReference: (path: string) => void
  appendSnippetReference: (
    path: string,
    lineStart: number,
    lineEnd: number,
    snippet: string,
  ) => void
  appendTerminalReference: (label: string, content: string) => void
  handleInput: () => void
  handleKeyDown: (e: ReactKeyboardEvent) => void
  send: () => void
  onSend: ReturnType<typeof vi.fn>
  setCursorEnd: () => void
  editor: HTMLDivElement
}

/** 带真实 contenteditable 编辑器的 composer：pill 渲染/解析与光标定位全链路。 */
function renderComposerWithEditor(): PillInsertResult {
  const editor = document.createElement('div')
  editor.setAttribute('contenteditable', 'true')
  document.body.appendChild(editor)
  const onSend = vi.fn()
  const { result } = renderHook(
    () =>
      useComposer({
        onSend,
        onAbort: vi.fn(),
        onSteer: vi.fn(),
        isStreaming: false,
        hasHistory: false,
        commands: [],
      }),
    { wrapper: strictWrapper },
  )
  act(() => {
    result.current.editorRef.current = editor
  })
  const setCursorEnd = () => {
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }
  return {
    promptRef: result.current.promptRef as PillInsertResult['promptRef'],
    insertFile: result.current.insertFile,
    appendFileReference: result.current.appendFileReference,
    appendSnippetReference: result.current.appendSnippetReference,
    appendTerminalReference: result.current.appendTerminalReference,
    handleInput: result.current.handleInput,
    handleKeyDown: result.current.handleKeyDown,
    send: result.current.send,
    onSend,
    setCursorEnd,
    editor,
  }
}

/** 编辑器 DOM 末尾追加文本节点并同步光标（模拟用户键入）。 */
function typeText(c: PillInsertResult, text: string): void {
  act(() => {
    c.editor.appendChild(document.createTextNode(text))
    c.setCursorEnd()
    c.handleInput()
  })
}

const pillTypes = (c: PillInsertResult): string[] =>
  (c.promptRef.current.map((p: { type: string }) => p.type) as string[]).filter((t) => t !== 'text')

describe('useComposer pill 保留', () => {
  it('insertFile（@ popover）保留既有 file/snippet/terminal pill', () => {
    const c = renderComposerWithEditor()
    act(() => {
      c.appendFileReference('src/a.ts')
      c.appendSnippetReference('src/b.ts', 1, 3, 'snippet-b')
      c.appendTerminalReference('🖥 cmd', 'out')
    })
    expect(pillTypes(c)).toEqual(['file', 'snippet', 'terminal'])
    typeText(c, '@b')
    act(() => {
      c.insertFile('src/c.ts')
    })
    // 旧 pill 全保留，新 file pill 追加
    expect(pillTypes(c)).toEqual(['file', 'snippet', 'terminal', 'file'])
    expect(promptToText(c.promptRef.current as never)).toContain('src/a.ts')
    expect(promptToText(c.promptRef.current as never)).toContain('src/c.ts')
  })

  it('appendFileReference 保留既有 snippet/terminal pill', () => {
    const c = renderComposerWithEditor()
    act(() => {
      c.appendSnippetReference('src/b.ts', 1, 3, 'snippet-b')
      c.appendTerminalReference('🖥 cmd', 'out')
      c.appendFileReference('src/a.ts')
    })
    expect(pillTypes(c)).toEqual(['snippet', 'terminal', 'file'])
  })

  it('send 的 files 包含全部 file pill（未被降级为文本）', () => {
    const c = renderComposerWithEditor()
    act(() => {
      c.appendFileReference('src/a.ts')
    })
    typeText(c, '@b')
    act(() => {
      c.insertFile('src/c.ts')
    })
    act(() => {
      c.send()
    })
    expect(c.onSend).toHaveBeenCalledTimes(1)
    const payload = c.onSend.mock.calls[0]?.[0] as { files: string[]; images: ImagePart[] }
    expect(payload.files).toEqual(['src/a.ts', 'src/c.ts'])
  })

  it('历史回溯 ↑ 后 ↓ 退出，恢复带 pill 的草稿（不被降级为文本）', () => {
    const c = renderComposerWithEditor()
    act(() => {
      c.appendFileReference('src/a.ts')
      saveHistory(['old'])
    })
    // ↑ 进入历史：草稿被暂存，当前显示历史条目文本
    act(() => {
      c.handleKeyDown({ key: 'ArrowUp', preventDefault: vi.fn() } as unknown as ReactKeyboardEvent)
    })
    expect(promptToText(c.promptRef.current as never)).toBe('old')
    // ↓ 退出历史：恢复草稿——file pill 必须原样回来
    act(() => {
      c.handleKeyDown({
        key: 'ArrowDown',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent)
    })
    expect(pillTypes(c)).toEqual(['file'])
    expect(promptToText(c.promptRef.current as never)).toContain('src/a.ts')
    act(() => {
      c.send()
    })
    const payload = c.onSend.mock.calls[0]?.[0] as { files: string[] }
    expect(payload.files).toEqual(['src/a.ts'])
  })
})
