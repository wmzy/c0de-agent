import type { Message, MessageContent } from '@shared/types/message.js'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MessageBubble } from './MessageBubble.js'

function msg(role: 'user' | 'assistant', parts: MessageContent[]): Message {
  return { id: '1', sessionId: 's', role, content: parts, tokenCount: 0, createdAt: 1 }
}

describe('MessageBubble', () => {
  it('渲染 user 角色', () => {
    render(<MessageBubble message={msg('user', [{ _tag: 'text', text: 'hi' }])} />)
    const el = screen.getByTestId('message')
    expect(el.getAttribute('data-role')).toBe('user')
  })

  it('渲染 assistant 工具调用', () => {
    render(
      <MessageBubble
        message={msg('assistant', [
          { _tag: 'tool_call', id: 't1', tool: 'read', input: { path: 'a.ts' } },
        ])}
      />,
    )
    expect(screen.getByText('read')).toBeTruthy()
  })

  it('thinking 折叠', () => {
    const { container } = render(
      <MessageBubble message={msg('assistant', [{ _tag: 'thinking', text: 'hmm' }])} />,
    )
    expect(container.querySelector('summary')?.textContent).toBe('思考过程')
  })
})
