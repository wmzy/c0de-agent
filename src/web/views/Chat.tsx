import { useEffect, useRef } from 'react'
import { css } from '@linaria/core'
import type { Message } from '@shared/types/message.js'
import { MessageBubble } from '../components/MessageBubble.js'
import { StreamingIndicator } from '../components/StreamingIndicator.js'
import { PermissionDialog } from '../components/PermissionDialog.js'
import { InputArea } from '../components/InputArea.js'
import { formatTokenCount } from '../utils/format.js'

type ChatProps = {
  messages: Message[]
  isStreaming: boolean
  usage: { input: number; output: number } | null
  pendingPermission: { toolCallId: string; tool: string } | null
  onSend: (text: string) => void
  onAbort: () => void
  onConfirm: (toolCallId: string, approved: boolean) => void
}

const stream = css`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
  overflow-y: auto;
`

const toolbar = css`
  display: flex;
  justify-content: space-between;
  padding: 4px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-secondary);
`

export function Chat({
  messages,
  isStreaming,
  usage,
  pendingPermission,
  onSend,
  onAbort,
  onConfirm,
}: ChatProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <>
      <div className={toolbar}>
        <span>
          {usage
            ? `${formatTokenCount(usage.input)} → ${formatTokenCount(usage.output)} tokens`
            : 'c0de-agent'}
        </span>
        {isStreaming ? (
          <button onClick={onAbort} type="button" data-testid="abort">
            中止
          </button>
        ) : null}
      </div>
      <div className={stream} data-testid="stream">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {isStreaming && <StreamingIndicator />}
        <div ref={bottomRef} />
      </div>
      {pendingPermission && (
        <PermissionDialog
          tool={pendingPermission.tool}
          input={null}
          onConfirm={() => onConfirm(pendingPermission.toolCallId, true)}
          onCancel={() => onConfirm(pendingPermission.toolCallId, false)}
        />
      )}
      <InputArea onSend={onSend} disabled={isStreaming} />
    </>
  )
}
