import { css } from '@linaria/core'
import type { Message } from '@shared/types/message.js'
import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { InputArea } from '../components/InputArea.js'
import { MessageBubble } from '../components/MessageBubble.js'
import { PermissionDialog } from '../components/PermissionDialog.js'
import { StreamingIndicator } from '../components/StreamingIndicator.js'
import { formatTokenCount } from '../utils/format.js'

type ChatProps = {
  messages: Message[]
  isStreaming: boolean
  usage: { input: number; output: number } | null
  error?: string | null
  pendingPermission: { toolCallId: string; tool: string } | null
  onSend: (text: string) => void
  onAbort: () => void
  onConfirm: (toolCallId: string, approved: boolean) => void
  modelBar?: ReactNode
  /** 插入到工具栏与消息流之间的面板（如 LLM 调用详情）。 */
  topPanel?: ReactNode
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

const footerBar = css`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
`

export function Chat({
  messages,
  isStreaming,
  usage,
  error,
  pendingPermission,
  onSend,
  onAbort,
  onConfirm,
  modelBar,
  topPanel,
}: ChatProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  return (
    <>
      <div className={toolbar}>
        <span style={error ? { color: 'var(--danger, #e5484d)' } : undefined}>
          {error
            ? error
            : usage
              ? `${formatTokenCount(usage.input)} → ${formatTokenCount(usage.output)} tokens`
              : 'c0de-agent'}
        </span>
        {isStreaming ? (
          <button onClick={onAbort} type="button" data-testid="abort">
            中止
          </button>
        ) : null}
      </div>
      {topPanel}
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
      {modelBar && <div className={footerBar}>{modelBar}</div>}
      <InputArea onSend={onSend} disabled={isStreaming} />
    </>
  )
}
