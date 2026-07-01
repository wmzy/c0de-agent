import { css } from '@linaria/core'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { StreamingIndicator } from '../components/StreamingIndicator.js'
import { TimelineChat } from '../components/session/TimelineChat.js'
import type { TimelineRow } from '../components/session/utils/timeline.js'
import { Composer, type SendPayload } from '../composer/Composer.js'
import { type PermissionMode, permissionAPI } from '../services/permission.js'
import { formatTokenCount } from '../utils/format.js'
import { TableView } from './TableView.js'

export type { SendPayload }

type ChatProps = {
  /** 统一时间线（消息 + LLM 调用 + 段标记），替代原 messages。 */
  timeline: TimelineRow[]
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
  /** 插入到工具栏与消息流之间的面板（如会话摘要）。 */
  topPanel?: ReactNode
  /** 当前项目 id（用于 @ 文件提及按项目 worktree 搜索）。 */
  projectId?: string
}

const toolbar = css`
  display: flex;
  justify-content: space-between;
  padding: 4px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-secondary);
`

const viewBar = css`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  font-size: 12px;
`

const viewSwitch = css`
  display: inline-flex;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;

  & > button {
    border: none;
    background: transparent;
    color: var(--text-secondary);
    padding: 3px 12px;
    cursor: pointer;
    font-size: 12px;

    &[aria-pressed='true'] {
      background: var(--bg);
      color: var(--text);
    }
  }
`

const jsonSwitch = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  color: var(--text-secondary);
`

const stream = css`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
  overflow-y: auto;
`

const footerBar = css`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 4px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
`

const footerLeft = css`
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
`

const steerRow = css`
  display: flex;
  padding: 4px 12px;

  & > button {
    font-size: 12px;
    color: var(--text);
    background: none;
    border: 1px solid var(--border, #2a2a3e);
    border-radius: 6px;
    padding: 2px 10px;
    cursor: pointer;

    &[aria-pressed='true'] {
      color: var(--text);
      border-color: var(--primary);
    }
  }
`

const modeBar = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
  font-size: 12px;
`

const modeToggle = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 44px;
  padding: 4px 8px;
  cursor: pointer;
  user-select: none;
`

const modeWarn = css`
  color: var(--error);
`

export function Chat({
  timeline,
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
  projectId,
}: ChatProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  // 视图模式：聊天（默认美化）/ 表格。全局「原始 JSON」仅作用于聊天模式。
  const [viewMode, setViewMode] = useState<'chat' | 'table'>('chat')
  const [showAllJson, setShowAllJson] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在时间线长度变化时滚动，避免内容更新触发抖动
  useEffect(() => {
    if (viewMode !== 'chat') return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [timeline.length, viewMode])

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

  // 全局授权模式（YOLO 自动授权）：运行时可切换，进程内不持久化。
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default')
  useEffect(() => {
    permissionAPI
      .getMode()
      .then((res) => setPermissionMode(res.mode))
      .catch(() => {})
  }, [])
  const togglePermissionMode = () => {
    const next: PermissionMode = permissionMode === 'auto' ? 'default' : 'auto'
    setPermissionMode(next)
    permissionAPI.setMode(next).catch(() => setPermissionMode(permissionMode))
  }

  return (
    <>
      <div className={toolbar}>
        <span style={error ? { color: 'var(--error)' } : undefined}>
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
      <div className={viewBar} data-testid="view-bar">
        <fieldset className={viewSwitch} aria-label="视图模式">
          <button
            type="button"
            aria-pressed={viewMode === 'chat'}
            onClick={() => setViewMode('chat')}
            data-testid="view-chat"
          >
            聊天
          </button>
          <button
            type="button"
            aria-pressed={viewMode === 'table'}
            onClick={() => setViewMode('table')}
            data-testid="view-table"
          >
            表格
          </button>
        </fieldset>
        {viewMode === 'chat' && (
          <label className={jsonSwitch}>
            <input
              type="checkbox"
              checked={showAllJson}
              onChange={(e) => setShowAllJson(e.target.checked)}
              data-testid="toggle-all-json"
            />
            原始 JSON（含隐藏条目）
          </label>
        )}
      </div>
      {viewMode === 'table' ? (
        <TableView rows={timeline} />
      ) : (
        <div className={stream} data-testid="stream">
          <TimelineChat rows={timeline} showAllJson={showAllJson} />
          {isStreaming && <StreamingIndicator />}
          <div ref={bottomRef} />
        </div>
      )}
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
          {steerMode ? '完成' : '追加指令'}
        </button>
      </div>
      <div className={modeBar} data-testid="permission-mode-bar">
        <label className={modeToggle}>
          <input
            type="checkbox"
            checked={permissionMode === 'auto'}
            onChange={togglePermissionMode}
            data-testid="permission-mode-toggle"
          />
          自动授权
        </label>
        {permissionMode === 'auto' && (
          <span className={modeWarn}>将自动执行所有工具（含 bash），无需确认</span>
        )}
      </div>
      <Composer
        projectId={projectId}
        onSend={handleSend}
        onAbort={onAbort}
        isStreaming={isStreaming}
        steerMode={steerMode}
        hasHistory={timeline.length > 0}
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
