import { css } from '@linaria/core'
import type { Message } from '@shared/types/message.js'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { StreamingIndicator } from '../components/StreamingIndicator.js'
import { MessageItem } from '../components/session/MessageItem.js'
import { Composer, type SendPayload } from '../composer/Composer.js'
import { formatTokenCount } from '../utils/format.js'

export type { SendPayload }

type ChatProps = {
  messages: Message[]
  isStreaming: boolean
  usage: { input: number; output: number } | null
  error?: string | null
  pendingPermission: { toolCallId: string; tool: string; input: unknown } | null
  onSend: (payload: SendPayload) => void
  onAbort: () => void
  onConfirm: (toolCallId: string, approved: boolean) => void
  /** 暂停 agent loop（spec §19）；isStreaming 时可用。 */
  onPause?: () => void
  /** 恢复已暂停的 agent loop。 */
  onResume?: () => void
  /** 注入 steering 消息（spec §3.9），运行中可用。 */
  onSteer?: (message: string) => void
  /** agent 是否处于暂停态（控制 pause/resume 按钮切换）。 */
  paused?: boolean
  supportsVision?: boolean
  modelBar?: ReactNode
  /** 底部工具栏右侧的工具开关（启用/禁用工具列表）。 */
  toolToggle?: ReactNode
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

const footerLeft = css`
  flex: 1;
  min-width: 0;
`

const steerRow = css`
  display: flex;
  padding: 4px 12px;

  & > button {
    font-size: 12px;
    color: var(--text-secondary);
    background: none;
    border: 1px solid var(--border, #2a2a3e);
    border-radius: 6px;
    padding: 2px 10px;
    cursor: pointer;

    &[aria-pressed='true'] {
      color: var(--text-primary, #fff);
      border-color: var(--accent, #4a9eff);
    }
  }
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
  onPause,
  onResume,
  onSteer,
  paused = false,
  modelBar,
  toolToggle,
  topPanel,
  supportsVision = true,
}: ChatProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在消息数量变化时滚动，避免内容更新触发抖动
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  // steer 模式：运行中注入 steering 消息（spec §3.9）。切到 steer 时输入不再被禁用，
  // 发送走 onSteer；发送后退出 steer 回到正常输入。
  const [steerMode, setSteerMode] = useState(false)
  const handleSend = (payload: SendPayload) => {
    if (steerMode) {
      onSteer?.(payload.text)
      setSteerMode(false)
    } else {
      onSend(payload)
    }
  }

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
        {isStreaming && !paused ? (
          <button onClick={onPause} type="button" data-testid="pause">
            暂停
          </button>
        ) : null}
        {isStreaming && paused ? (
          <button onClick={onResume} type="button" data-testid="resume">
            恢复
          </button>
        ) : null}
        {isStreaming ? (
          <button onClick={onAbort} type="button" data-testid="abort">
            中止
          </button>
        ) : null}
      </div>
      {topPanel}
      <div className={stream} data-testid="stream">
        {messages.map((m) => (
          <MessageItem key={m.id} message={m} />
        ))}
        {isStreaming && <StreamingIndicator />}
        <div ref={bottomRef} />
      </div>
      {(modelBar || toolToggle) && (
        <div className={footerBar}>
          {modelBar && <div className={footerLeft}>{modelBar}</div>}
          {toolToggle}
        </div>
      )}
      <div className={steerRow}>
        <button
          onClick={() => setSteerMode(!steerMode)}
          type="button"
          data-testid="steer-toggle"
          aria-pressed={steerMode}
        >
          {steerMode ? '退出注入' : '注入 steering'}
        </button>
      </div>
      <Composer
        onSend={handleSend}
        onAbort={onAbort}
        isStreaming={isStreaming}
        steerMode={steerMode}
        hasHistory={messages.length > 0}
        supportsVision={supportsVision}
        permission={
          pendingPermission
            ? { tool: pendingPermission.tool, input: pendingPermission.input }
            : null
        }
        onPermissionConfirm={() =>
          pendingPermission && onConfirm(pendingPermission.toolCallId, true)
        }
        onPermissionCancel={() =>
          pendingPermission && onConfirm(pendingPermission.toolCallId, false)
        }
      />
    </>
  )
}
