import type { Message, MessageContent } from '@shared/types/message.js'
import { cleanup, render as rtlRender, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSelectionContext } from '../../contexts/FileSelectionContext.js'
import { MessageItem } from './MessageItem.js'

afterEach(() => cleanup())

// tool 调用块经 FilePathLink 依赖 FileSelectionContext，需包裹 Provider
function SelectionWrapper({ children }: { children: React.ReactNode }) {
  return (
    <FileSelectionContext.Provider
      value={{ selectedFile: null, openFile: () => {}, closeFile: () => {} }}
    >
      {children}
    </FileSelectionContext.Provider>
  )
}
const render = (ui: React.ReactNode) => rtlRender(ui, { wrapper: SelectionWrapper })

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
})
