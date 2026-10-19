import type { Message, MessageContent } from '@shared/types/message.js'
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageItem } from '@/components/session/MessageItem.js'
import { type ShakeModeValue, ShakeProvider } from '@/components/session/ShakeContext.js'
import { normalizeParts } from '@/components/session/utils/normalizeParts.js'
import { FileSelectionContext } from '@/contexts/FileSelectionContext.js'
import type { ShakeRegionView } from '@/types/index.js'

afterEach(() => cleanup())

// tool 调用块经 FilePathLink 依赖 FileSelectionContext，需包裹 Provider
function SelectionWrapper({
  children,
  shakeValue,
}: {
  children: React.ReactNode
  shakeValue?: ShakeModeValue
}) {
  const inner = (
    <FileSelectionContext.Provider
      value={{ selectedFile: null, openFile: () => {}, closeFile: () => {} }}
    >
      {children}
    </FileSelectionContext.Provider>
  )
  return shakeValue ? <ShakeProvider value={shakeValue}>{inner}</ShakeProvider> : inner
}
function render(ui: React.ReactNode, shakeValue?: ShakeModeValue) {
  return rtlRender(ui, { wrapper: (p) => <SelectionWrapper {...p} shakeValue={shakeValue} /> })
}

function msg(role: 'user' | 'assistant', parts: MessageContent[]): Message {
  return { id: '1', sessionId: 's', role, content: parts, tokenCount: 0, createdAt: 1 }
}

describe('MessageItem', () => {
  it('渲染 user 角色标记', () => {
    render(<MessageItem message={msg('user', [{ _tag: 'text', text: 'hi' }])} />)
    expect(screen.getByTestId('message').getAttribute('data-role')).toBe('user')
  })

  it('渲染 assistant 角色标记', () => {
    render(<MessageItem message={msg('assistant', [{ _tag: 'text', text: 'hello' }])} />)
    expect(screen.getByTestId('message').getAttribute('data-role')).toBe('assistant')
  })

  it('渲染 tool 调用块', () => {
    render(
      <MessageItem
        message={msg('assistant', [
          { _tag: 'tool_call', id: 't1', tool: 'read', input: { path: 'a.ts' } },
        ])}
      />,
    )
    expect(screen.getByTestId('tool-status').getAttribute('data-status')).toBe('running')
  })

  it('渲染 thinking 块（折叠）', () => {
    render(<MessageItem message={msg('assistant', [{ _tag: 'thinking', text: 'hmm' }])} />)
    expect(screen.getByTestId('reasoning').getAttribute('data-expanded')).toBe('false')
  })

  it('多 part 渲染为多个块', () => {
    render(
      <MessageItem
        message={msg('assistant', [
          { _tag: 'text', text: 'a' },
          { _tag: 'tool_call', id: 't', tool: 'read', input: { path: 'x' } },
        ])}
      />,
    )
    expect(screen.getAllByTestId('decoration')).toHaveLength(2)
  })

  // ---- Shake 内联高亮 ----

  function shakeValue(overrides: Partial<ShakeModeValue> = {}): ShakeModeValue {
    return {
      enabled: true,
      regionsByMessage: new Map(),
      selected: new Set(),
      onToggle: vi.fn(),
      ...overrides,
    }
  }

  const toolRegion: ShakeRegionView = {
    id: '1:toolResult:1',
    kind: 'toolResult',
    messageId: '1',
    messageIndex: 0,
    partIndex: 1,
    tokens: 800,
    label: 'bash',
    preview: 'huge output...',
    placeholder: '[shaken: bash, 800 tokens]',
    isAfterProtectWindow: true,
    toolCallId: 'tc1',
  }

  const blockRegion: ShakeRegionView = {
    id: '1:block:0:0',
    kind: 'block',
    messageId: '1',
    messageIndex: 0,
    partIndex: 0,
    tokens: 500,
    label: 'assistant',
    preview: '```ts\n...',
    placeholder: '[shaken]',
    isAfterProtectWindow: true,
  }

  it('shake 模式启用时 toolResult 块高亮', () => {
    const onToggle = vi.fn()
    const sv = shakeValue({
      regionsByMessage: new Map([['1', [toolRegion]]]),
      onToggle,
    })
    render(
      <MessageItem
        message={msg('assistant', [
          { _tag: 'tool_call', id: 'tc1', tool: 'bash', input: { command: 'ls' } },
          {
            _tag: 'tool_result',
            id: 'tc1',
            tool: 'bash',
            output: { _tag: 'success', output: 'result' },
          },
        ])}
      />,
      sv,
    )
    const shakeBlock = screen.getByTestId('shake-inline-block')
    expect(shakeBlock.getAttribute('data-shake-selected')).toBe('false')
  })

  it('shake 模式启用时 text block 高亮', () => {
    const sv = shakeValue({
      regionsByMessage: new Map([['1', [blockRegion]]]),
    })
    render(<MessageItem message={msg('assistant', [{ _tag: 'text', text: 'hello' }])} />, sv)
    expect(screen.getByTestId('shake-inline-block')).toBeTruthy()
  })

  it('shake 模式未启用时不高亮', () => {
    const sv = shakeValue({
      enabled: false,
      regionsByMessage: new Map([['1', [toolRegion]]]),
    })
    render(
      <MessageItem
        message={msg('assistant', [
          { _tag: 'tool_call', id: 'tc1', tool: 'bash', input: { command: 'ls' } },
        ])}
      />,
      sv,
    )
    expect(screen.queryByTestId('shake-inline-block')).toBeNull()
  })

  // 选中态此前只落在 data-shake-selected 与样式上，读屏无从判断这块是否已加入
  // shake 范围（div[role=button] 必须用 aria-pressed 表达按下态）。
  it('shake 高亮块的 aria-pressed 反映选中态', () => {
    const unselected = shakeValue({
      regionsByMessage: new Map([['1', [blockRegion]]]),
    })
    const { unmount } = render(
      <MessageItem message={msg('assistant', [{ _tag: 'text', text: 'hello' }])} />,
      unselected,
    )
    expect(screen.getByTestId('shake-inline-block').getAttribute('aria-pressed')).toBe('false')
    unmount()

    const selected = shakeValue({
      regionsByMessage: new Map([['1', [blockRegion]]]),
      selected: new Set(['1:block:0:0']),
    })
    render(<MessageItem message={msg('assistant', [{ _tag: 'text', text: 'hello' }])} />, selected)
    expect(screen.getByTestId('shake-inline-block').getAttribute('aria-pressed')).toBe('true')
  })

  it('点击 shake 高亮块调用 onToggle', () => {
    const onToggle = vi.fn()
    const sv = shakeValue({
      regionsByMessage: new Map([['1', [blockRegion]]]),
      onToggle,
    })
    render(<MessageItem message={msg('assistant', [{ _tag: 'text', text: 'hello' }])} />, sv)
    fireEvent.click(screen.getByTestId('shake-inline-block'))
    expect(onToggle).toHaveBeenCalledWith('1:block:0:0')
  })

  // 回归：shake 高亮块是 div[role=button]，块内还嵌着真 <button>（复制/展开收起/
  // 工具折叠头/路径链接）。keydown 不放行冒泡事件时 preventDefault 会吃掉按钮自身
  // 的 Enter/Space 激活——复制、展开、打开文件全部失灵，Enter 只换来一次静默的
  // shake 选中切换。与 ToolBlock 头部（ToolBlock.tsx 的 onHeaderKeyDown）同款判据。
  it('块内嵌按钮冒泡的 Enter/Space 不触发 shake 切换', () => {
    const onToggle = vi.fn()
    const sv = shakeValue({
      regionsByMessage: new Map([['1', [blockRegion]]]),
      onToggle,
    })
    render(<MessageItem message={msg('assistant', [{ _tag: 'text', text: 'hello' }])} />, sv)
    const copy = screen.getByTestId('copy-button')
    fireEvent.keyDown(copy, { key: 'Enter' })
    fireEvent.keyDown(copy, { key: ' ' })
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('点击块内工具折叠头不反选 shake 区域', () => {
    const onToggle = vi.fn()
    const sv = shakeValue({
      regionsByMessage: new Map([['1', [toolRegion]]]),
      onToggle,
    })
    render(
      <MessageItem
        message={msg('assistant', [
          { _tag: 'tool_call', id: 'tc1', tool: 'bash', input: { command: 'ls' } },
          {
            _tag: 'tool_result',
            id: 'tc1',
            tool: 'bash',
            output: { _tag: 'success', output: 'result' },
          },
        ])}
      />,
      sv,
    )
    fireEvent.click(screen.getByTestId('tool-header'))
    expect(onToggle).not.toHaveBeenCalled()
  })

  // 回归：真实点击落在块内普通内容（正文 div）上时，closest 沿祖先链会命中包装层
  // 自身的 role="button"——若判据写成「命中即返回」，点块内任意空白处都不再切换选中，
  // 主交互失效（happy-dom 里 fireEvent.click(包装层) 的 target === currentTarget，
  // 覆盖不到这条路径，只有真实浏览器点得出来）。
  it('点击块内普通内容仍切换 shake 选中', () => {
    const onToggle = vi.fn()
    const sv = shakeValue({
      regionsByMessage: new Map([['1', [blockRegion]]]),
      onToggle,
    })
    render(<MessageItem message={msg('assistant', [{ _tag: 'text', text: 'hello' }])} />, sv)
    fireEvent.click(screen.getByTestId('assistant-text'))
    expect(onToggle).toHaveBeenCalledWith('1:block:0:0')
  })

  it('已选中的块 data-shake-selected=true', () => {
    const sv = shakeValue({
      regionsByMessage: new Map([['1', [toolRegion]]]),
      selected: new Set(['1:toolResult:1']),
    })
    render(
      <MessageItem
        message={msg('assistant', [
          { _tag: 'tool_call', id: 'tc1', tool: 'bash', input: { command: 'ls' } },
          {
            _tag: 'tool_result',
            id: 'tc1',
            tool: 'bash',
            output: { _tag: 'success', output: 'result' },
          },
        ])}
      />,
      sv,
    )
    expect(screen.getByTestId('shake-inline-block').getAttribute('data-shake-selected')).toBe(
      'true',
    )
  })

  it('shake 模式自动展开折叠的 ToolBlock', () => {
    const sv = shakeValue({
      regionsByMessage: new Map([['1', [toolRegion]]]),
    })
    render(
      <MessageItem
        message={msg('assistant', [
          { _tag: 'tool_call', id: 'tc1', tool: 'bash', input: { command: 'ls' } },
          {
            _tag: 'tool_result',
            id: 'tc1',
            tool: 'bash',
            output: { _tag: 'success', output: 'result' },
          },
        ])}
      />,
      sv,
    )
    // completed 状态默认折叠（tool-body 不存在）；shake 模式下应强制展开
    expect(screen.getByTestId('tool-body')).toBeTruthy()
    expect(screen.getByTestId('tool-header').getAttribute('data-expanded')).toBe('true')
  })

  it('shake 模式自动展开折叠的 ReasoningBlock', () => {
    const thinkingRegion: ShakeRegionView = {
      ...blockRegion,
      id: '1:block:0:0',
      partIndex: 0,
    }
    const sv = shakeValue({
      regionsByMessage: new Map([['1', [thinkingRegion]]]),
    })
    render(
      <MessageItem message={msg('assistant', [{ _tag: 'thinking', text: 'deep thought' }])} />,
      sv,
    )
    expect(screen.getByTestId('reasoning').getAttribute('data-expanded')).toBe('true')
  })
})

// 回归：normalizeParts 此前没有 image 分支，图片 part 被整个丢弃——
// 纯图片消息渲染成一整行空白（滞留条显示「(空消息)」），图文消息只见文字。
describe('MessageItem 图片渲染', () => {
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  it('纯图片消息渲染出可见的图片元素（此前渲染出空白行）', () => {
    render(
      <MessageItem message={msg('user', [{ _tag: 'image', mediaType: 'image/png', data: PNG }])} />,
    )
    const img = screen.getByTestId('message-image')
    expect(img).toBeInTheDocument()
    expect(img.getAttribute('src')).toContain('data:image/png;base64,')
    expect(img.getAttribute('alt')).toBeTruthy()
  })

  it('图文消息同时渲染文字和图片', () => {
    render(
      <MessageItem
        message={msg('user', [
          { _tag: 'text', text: '看图' },
          { _tag: 'image', mediaType: 'image/png', data: PNG },
        ])}
      />,
    )
    expect(screen.getByText('看图')).toBeInTheDocument()
    expect(screen.getByTestId('message-image')).toBeInTheDocument()
  })

  it('image part 产生 image 渲染块（normalizeParts 不丢弃）', () => {
    const blocks = normalizeParts(
      msg('user', [{ _tag: 'image', mediaType: 'image/png', data: PNG }]),
    )
    expect(blocks.some((b) => b.type === 'image')).toBe(true)
  })
})

// 裸 <img> 没有失败信号：图片解不出来时用户只看到浏览器的破图占位符，
// 装饰列照画图片图标、文本照显示「(图片)」，看起来「我发过一张图」，
// 却既没有原因也没有任何补救动作。
describe('MessageItem 图片解码失败', () => {
  it('解码失败时说明原因并给重试，而不是留一个破图占位符', () => {
    render(
      <MessageItem
        message={msg('user', [{ _tag: 'image', mediaType: 'image/png', data: 'bm90LWFuLWltYWdl' }])}
      />,
    )
    fireEvent.error(screen.getByTestId('message-image'))

    const err = screen.getByTestId('message-image-error')
    expect(err.textContent).toContain('图片无法显示')
    expect(err.textContent).toContain('image/png')
    expect(screen.getByTestId('message-image-retry')).toBeInTheDocument()
    expect(screen.queryByTestId('message-image')).toBeNull()
  })

  it('重试后重新渲染 <img>（重新解码），仍失败则再次给出原因', () => {
    render(
      <MessageItem
        message={msg('user', [
          { _tag: 'image', mediaType: 'image/webp', data: 'bm90LWFuLWltYWdl' },
        ])}
      />,
    )
    fireEvent.error(screen.getByTestId('message-image'))
    fireEvent.click(screen.getByTestId('message-image-retry'))

    const img = screen.getByTestId('message-image')
    expect(img.getAttribute('src')).toBe('data:image/webp;base64,bm90LWFuLWltYWdl')
    fireEvent.error(img)
    expect(screen.getByTestId('message-image-error')).toBeInTheDocument()
  })
})
