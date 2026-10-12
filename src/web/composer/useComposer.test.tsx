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
import { loadDraft } from '@/composer/draft.js'
import { loadHistory, saveHistory } from '@/composer/history.js'
import { type PopoverState, useComposer } from '@/composer/useComposer.js'
import type { CommandInfo } from '@/hooks/useCommands.js'

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
  /** 走**最新一次渲染**的 handler：Esc 的分支依赖当次渲染读到的 popover，
   *  上面的 handleKeyDown 是首帧闭包，按键前若有状态变化会读到过期值。 */
  pressKey: (e: ReactKeyboardEvent) => void
  send: () => void
  onSend: ReturnType<typeof vi.fn>
  setCursorEnd: () => void
  editor: HTMLDivElement
  popover: () => PopoverState
}

/** 带真实 contenteditable 编辑器的 composer：pill 渲染/解析与光标定位全链路。
 *  draftScope 传入时才落 localStorage（草稿持久化域），用于断言「什么该落盘」。 */
function renderComposerWithEditor(draftScope?: string, commands?: CommandInfo[]): PillInsertResult {
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
        commands: commands ?? [],
        draftScope,
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
    pressKey: (e) => result.current.handleKeyDown(e),
    send: result.current.send,
    onSend,
    setCursorEnd,
    editor,
    popover: () => result.current.popover,
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

  /**
   * 回归：↑ 回溯把历史条目当草稿落盘，顶掉用户正在写的那份。
   *
   * 缺陷：历史导航走 setPromptExternal，而它无条件 persistDraft。实测（隔离
   * dev server）：输入「我写了一半的草稿」→ 按 ↑ → localStorage 里
   * composer-draft.v1:s:<sessionId> 变成「历史里的第一条提示」。原草稿只在
   * draftRef 内存里，用户此时切会话/刷新即永久丢失——包括草稿里的 @file pill
   * 与图片附件。回溯只是「看一条旧提示」，不该改写草稿。
   */
  it('↑ 回溯不把历史条目写成本会话草稿', () => {
    const scope = 's:draft-scope-1'
    const c = renderComposerWithEditor(scope)
    act(() => {
      c.appendFileReference('src/a.ts')
      saveHistory(['历史里的第一条提示'])
    })
    typeText(c, '我写了一半的草稿')
    expect(loadDraft(scope)?.prompt).toBeDefined()

    act(() => {
      c.handleKeyDown({ key: 'ArrowUp', preventDefault: vi.fn() } as unknown as ReactKeyboardEvent)
    })
    // 输入框显示的是召回的历史条目
    expect(promptToText(c.promptRef.current as never)).toBe('历史里的第一条提示')
    // 但草稿存储里仍是用户原来那份（含 file pill）
    const stored = loadDraft(scope)
    expect(stored).not.toBeNull()
    expect(promptToText(stored?.prompt ?? [])).toContain('我写了一半的草稿')
    expect(stored?.prompt.map((p) => p.type)).toContain('file')

    // ↓ 退出历史：草稿原样回到输入框，且此时才落盘
    act(() => {
      c.handleKeyDown({
        key: 'ArrowDown',
        preventDefault: vi.fn(),
      } as unknown as ReactKeyboardEvent)
    })
    expect(promptToText(c.promptRef.current as never)).toContain('我写了一半的草稿')
    expect(promptToText(loadDraft(scope)?.prompt ?? [])).toContain('我写了一半的草稿')
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

  // 复现：send 把 promptToMessageText（**提交给后端的展开形态**：snippet pill
  // 展开成带行号的代码块、terminal pill 展开成 ```terminal 代码块）写进提示历史。
  // 历史是 UI 便利功能（↑ 召回用户刚发的内容），存展开形态后：召回一条带引用的
  // 消息会把整段代码块当纯文本灌回输入框（用户看到的输入被替换成几百行代码），
  // 去重比较（prependHistoryEntry）也在展开形态上做。
  it('提示历史存用户可见文本，不存 snippet/terminal 展开的代码块', () => {
    const c = renderComposerWithEditor()
    act(() => {
      c.appendSnippetReference('src/b.ts', 1, 3, 'SNIPPET-BODY-CODE')
      c.appendTerminalReference('🖥 cmd', 'TERMINAL-OUTPUT')
    })
    typeText(c, '看看这个')
    act(() => {
      c.send()
    })
    const entry = loadHistory()[0] ?? ''
    expect(entry).toContain('看看这个')
    // 用户可见标签在（pill 标签），展开内容不在
    expect(entry).toContain('src/b.ts')
    expect(entry).toContain('🖥 cmd')
    expect(entry).not.toContain('SNIPPET-BODY-CODE')
    expect(entry).not.toContain('TERMINAL-OUTPUT')
    expect(entry).not.toContain('```')
  })
})

// ── 发送失败还原 ──
// 发送即清空是既定体感，但 onSend 落到 false（会话创建失败/流式首步失败）时，
// 此前输入已被丢掉，用户只能凭记忆重打。此文件锁住「失败把草稿原样还回」：
// 文本 + pill + 图片 + 提示历史条目，且成功路径不被误还原。

describe('useComposer 发送失败还原', () => {
  it('onSend 返回 Promise<false>：文本、file pill、图片与提示历史一并还原', async () => {
    saveHistory([]) // 历史是 localStorage 持久态，先清干净再断言头一条
    const c = renderComposerWithEditor()
    typeText(c, '修一下')
    act(() => {
      c.appendFileReference('src/a.ts')
    })
    c.onSend.mockResolvedValueOnce(false)
    act(() => {
      c.send()
    })
    // 清空立即发生（编辑器空态保留 ZWSP 光标锚点，剥掉再比）
    expect(c.editor.textContent?.replaceAll('\u200b', '').trim()).toBe('')
    await act(async () => {
      await Promise.resolve()
    })
    // 失败后还原：文本与 pill 都回来
    expect(c.editor.textContent).toContain('修一下')
    expect(pillTypes(c)).toContain('file')
    // 未发出的消息不进 ↑ 历史（草稿已回到输入框，历史只记真正发出的）
    expect(loadHistory()).toEqual([])
  })

  it('onSend 同步返回 false：同样还原', () => {
    const c = renderComposerWithEditor()
    typeText(c, '同步失败')
    c.onSend.mockReturnValueOnce(false)
    act(() => {
      c.send()
    })
    expect(c.editor.textContent).toContain('同步失败')
    expect(pillTypes(c)).toEqual([])
  })

  it('onSend 成功（true/undefined）：清空保持，不触发还原', async () => {
    const c = renderComposerWithEditor()
    typeText(c, '成功路径')
    c.onSend.mockResolvedValueOnce(true)
    act(() => {
      c.send()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(c.editor.textContent?.replaceAll('\u200b', '').trim()).toBe('')
    expect(pillTypes(c)).toEqual([])
  })

  // 输入框在请求在途期间仍可编辑（ComposerEditor 没有只读路径），失败还原必须
  // 认得「用户已经敲了新东西」，否则慢失败会凭空吞掉那段时间的输入。
  it('在途期间用户又敲了字：失败还原不得覆盖新内容', async () => {
    const c = renderComposerWithEditor()
    typeText(c, '第一条')
    let resolveSend: (v: boolean) => void = () => {}
    c.onSend.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveSend = resolve
      }),
    )
    act(() => {
      c.send()
    })
    // 请求在途：用户接着输入
    typeText(c, '接着写的')
    await act(async () => {
      resolveSend(false)
      await Promise.resolve()
    })
    expect(c.editor.textContent).toContain('接着写的')
    expect(c.editor.textContent).not.toContain('第一条')
  })

  it('在途期间又发了一次：第一条失败不再回填（否则盖掉第二次的输入）', async () => {
    const c = renderComposerWithEditor()
    typeText(c, '第一条')
    let resolveFirst: (v: boolean) => void = () => {}
    c.onSend.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveFirst = resolve
      }),
    )
    act(() => {
      c.send()
    })
    // 用户不等它，直接再发一条（第二次立即成功）
    typeText(c, '第二条')
    c.onSend.mockReturnValueOnce(true)
    act(() => {
      c.send()
    })
    await act(async () => {
      resolveFirst(false)
      await Promise.resolve()
    })
    expect(c.editor.textContent?.replaceAll('\u200b', '').trim()).toBe('')
  })

  // 期间若有别的发送插进来，entries[0] 已是别人的条目——按「头一条变了就撤」
  // 会把那条真正发出去的消息从历史里删掉。
  it('在途期间别的发送插队：不删除不属于本次的历史条目', async () => {
    saveHistory([])
    const c = renderComposerWithEditor()
    typeText(c, '第一条')
    let resolveFirst: (v: boolean) => void = () => {}
    c.onSend.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveFirst = resolve
      }),
    )
    act(() => {
      c.send()
    })
    // 第二次发送成功，历史里现在压着「第二条」
    typeText(c, '第二条')
    c.onSend.mockReturnValueOnce(true)
    act(() => {
      c.send()
    })
    expect(loadHistory()[0]).toBe('第二条')
    await act(async () => {
      resolveFirst(false)
      await Promise.resolve()
    })
    // 「第二条」确实发出去了，历史必须留着它
    expect(loadHistory()[0]).toBe('第二条')
  })
})

/**
 * 追加指令（steer）的输入清空时机。
 *
 * 缺陷：steer 无条件清空输入框，但「追加指令」并不保证被送达——后端
 * POST /api/chat/steer 在没有进行中的 run 时回 {steered:false}，指令既没注入
 * run 也没落库。此前用户敲的整段指令随清空一起消失，屏幕上没有任何痕迹，
 * 只能凭记忆重打（与「发送失败把输入还回去」的口径也自相矛盾）。
 */
describe('useComposer 追加指令的清空时机', () => {
  function renderStreamingComposer(onSteer: (m: string) => undefined | Promise<boolean>) {
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    document.body.appendChild(editor)
    const { result } = renderHook(
      () =>
        useComposer({
          onSend: vi.fn(),
          onAbort: vi.fn(),
          onSteer,
          isStreaming: true,
          hasHistory: false,
          commands: [],
        }),
      { wrapper: strictWrapper },
    )
    act(() => {
      result.current.editorRef.current = editor
    })
    const type = (text: string) => {
      act(() => {
        editor.appendChild(document.createTextNode(text))
        result.current.handleInput()
      })
    }
    return { result, editor, type }
  }

  it('后端回 steered:false 时输入原样保留（指令没送出去，不能凭空清空）', async () => {
    const { result, type } = renderStreamingComposer(() => Promise.resolve(false))
    type('改用 pnpm 跑测试')

    act(() => {
      result.current.steer()
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(promptToText(result.current.promptRef.current as never)).toContain('改用 pnpm')
  })

  it('确认受理后输入才清空（沿用「发出即清空」的体感）', async () => {
    const { result, type } = renderStreamingComposer(() => Promise.resolve(true))
    type('改用 pnpm 跑测试')

    act(() => {
      result.current.steer()
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(promptToText(result.current.promptRef.current as never)).toBe('')
  })
})

/**
 * 回归：子命令补全浮层里 Esc 是死键。
 *
 * 「commands 就绪后重新检测」的 effect 只依赖 [commands, popover]，Esc 把 popover
 * 置空后它立刻按同一段文本把浮层弹回来：用户按 Esc 想收起补全，菜单纹丝不动；
 * 紧接着的回车被浮层拦截，编辑器内容被改写成第一个候选（实测 /workflow list）
 * 而不是发送——正文就这么被静默改掉了。
 */
describe('useComposer 子命令补全浮层', () => {
  const commands: CommandInfo[] = [
    {
      name: 'workflow',
      description: '工作流',
      subcommands: [
        { name: 'list', description: 'list' },
        { name: 'run', description: 'run' },
      ],
    },
  ]

  it('Esc 关掉后不被重检测弹回来', () => {
    const c = renderComposerWithEditor(undefined, commands)
    typeText(c, '/workflow ')
    expect(c.popover()).toBe('subcommand')

    act(() => {
      c.pressKey({ key: 'Escape', preventDefault: vi.fn() } as unknown as ReactKeyboardEvent)
    })

    expect(c.popover()).toBe(null)
  })

  it('关掉后继续打字会重新补全（Esc 只压住当前这段文本）', () => {
    const c = renderComposerWithEditor(undefined, commands)
    typeText(c, '/workflow ')
    act(() => {
      c.pressKey({ key: 'Escape', preventDefault: vi.fn() } as unknown as ReactKeyboardEvent)
    })

    typeText(c, 'li')

    expect(c.popover()).toBe('subcommand')
  })

  it('关掉后回车走发送，不再把输入改写成候选', () => {
    const c = renderComposerWithEditor(undefined, commands)
    typeText(c, '/workflow ')
    act(() => {
      c.pressKey({ key: 'Escape', preventDefault: vi.fn() } as unknown as ReactKeyboardEvent)
    })

    act(() => {
      c.pressKey({ key: 'Enter', preventDefault: vi.fn() } as unknown as ReactKeyboardEvent)
    })

    expect(c.onSend).toHaveBeenCalled()
  })
})
