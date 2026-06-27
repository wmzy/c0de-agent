import { css } from '@linaria/core'
import type { Message } from '@shared/types/message.js'
import { Markdown } from './Markdown.js'
import { ToolCall } from './ToolCall.js'

const bubble = css`
  max-width: 80%;
  padding: 10px 14px;
  border-radius: 12px;
  margin: 8px 0;
  word-break: break-word;
`

const user = css`
  align-self: flex-end;
  background: var(--primary);
  color: #fff;
`

const asst = css`
  align-self: flex-start;
  background: var(--bg-secondary);
`

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'
  return (
    <div
      className={`${bubble} ${isUser ? user : asst}`}
      data-testid="message"
      data-role={message.role}
    >
      {message.content.map((part, i) => {
        switch (part._tag) {
          case 'text':
            // biome-ignore lint/suspicious/noArrayIndexKey: content parts are stable
            return <Markdown key={i} content={part.text} />
          case 'thinking':
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: content parts are stable
              <details key={i}>
                <summary>思考过程</summary>
                <Markdown content={part.text} />
              </details>
            )
          case 'tool_call':
            // biome-ignore lint/suspicious/noArrayIndexKey: content parts are stable
            return <ToolCall key={i} name={part.tool} input={part.input} />
          case 'tool_result':
            // biome-ignore lint/suspicious/noArrayIndexKey: content parts are stable
            return <ToolCall key={i} name={part.tool} input={null} result={part.output} />
          default:
            return null
        }
      })}
    </div>
  )
}
