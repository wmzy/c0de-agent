import { css } from '@linaria/core'
import type { ReactNode } from 'react'
import type { Message } from '@shared/types/message.js'
import { AssistantTextBlock } from './AssistantTextBlock.js'
import { PartDecoration } from './PartDecoration.js'
import { ReasoningBlock } from './ReasoningBlock.js'
import { ToolBlock } from './ToolBlock.js'
import { UserTextBlock } from './UserTextBlock.js'
import { normalizeParts } from './utils/normalizeParts.js'

const wrap = css`
  display: flex;
  flex-direction: column;
  padding: 4px 0;
`

const row = css`
  display: flex;
  gap: 8px;
  align-items: flex-start;
`

const content = css`
  flex: 1;
  min-width: 0;
  padding-top: 2px;
`

export function MessageItem({ message }: { message: Message }) {
  const blocks = normalizeParts(message)
  return (
    <div className={wrap} data-testid="message" data-role={message.role}>
      {blocks.map((block, i) => {
        let body: ReactNode = null
        switch (block.type) {
          case 'text':
            body =
              block.role === 'user' ? (
                <UserTextBlock text={block.text} />
              ) : (
                <AssistantTextBlock text={block.text} completedAt={message.createdAt || undefined} />
              )
            break
          case 'thinking':
            body = <ReasoningBlock text={block.text} />
            break
          case 'steering':
            body = <UserTextBlock text={block.text} />
            break
          case 'tool':
            body = <ToolBlock block={block} />
            break
        }
        return (
          <div className={row} key={`${block.type}-${i}`}>
            <PartDecoration block={block} />
            <div className={content}>{body}</div>
          </div>
        )
      })}
    </div>
  )
}
