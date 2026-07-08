import type { Message, MessageContent } from '@shared/types/message.js'
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSelectionContext } from '../../contexts/FileSelectionContext.js'
import type { ShakeRegionView } from '../../types/index.js'
import { MessageItem } from './MessageItem.js'
import { ShakeProvider, type ShakeModeValue } from './ShakeContext.js'

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

  function shakeValue(
    overrides: Partial<ShakeModeValue> = {},
  ): ShakeModeValue {
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
      <MessageItem message={msg('assistant', [{ _tag: 'thinking', text: 'deep thought' }])} />, sv,
    )
    expect(screen.getByTestId('reasoning').getAttribute('data-expanded')).toBe('true')
  })
})
