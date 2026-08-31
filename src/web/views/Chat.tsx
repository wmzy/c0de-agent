import { css } from '@linaria/core'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { StreamingIndicator } from '../components/StreamingIndicator.js'
import { StickyUserMessage } from '../components/session/StickyUserMessage.js'
import { TimelineChat } from '../components/session/TimelineChat.js'
import {
  isEmptyMessage,
  type TimelineRow,
  userMessageText,
} from '../components/session/utils/timeline.js'
import { Composer, type SendPayload } from '../composer/Composer.js'
import type { AgentListItem } from '../services/agent.js'
import { type PermissionMode, permissionAPI } from '../services/permission.js'
import { MOBILE } from '../styles/breakpoints.js'
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
  /** 插入到输入框上方的面板（如 todo）。 */
  bottomPanel?: ReactNode
  /** 当前项目 id（用于 @ 文件提及按项目 worktree 搜索）。 */
  projectId?: string
  /** 可用 agent 列表（@ mention 渲染与校验）。 */
  agents?: AgentListItem[]
  /** 时间线为空时渲染在消息流中央的空状态（欢迎区/示例卡片），由 ChatView 注入。 */
  emptyState?: ReactNode
}

/* 顶栏合并行：视图切换 + 运行状态 + 流控按钮 + 原始 JSON 单行排布，
 * 替代原先 toolbar/viewBar 两层横条，为消息流腾出垂直空间。 */
const topBar = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  font-size: 12px;
`

const topSpacer = css`
  flex: 1;
`

const topStatus = css`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
`

/* 流控按钮（暂停/恢复/中止）：ghost 化融入 secondary 底色横条；中止用 error 色警示 */
const ctlBtn = css`
  border: none;
  background: transparent;
  color: var(--text-secondary);
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 12px;
  /* 覆盖全局按钮 44px 最小尺寸：保持顶栏单行紧凑，触屏热区仍达 32px */
  min-height: 32px;
  min-width: auto;

  &:hover:not(:disabled) {
    color: var(--text);
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }
`

const ctlDanger = css`
  color: var(--error);
  &:hover:not(:disabled) {
    color: var(--error);
    background: color-mix(in srgb, var(--error) 10%, transparent);
  }
`

/* 主视图切换（聊天/表格）：无边框分段控件，白底 track 上灰底 pill + primary 文字，
 * 激活/未激活在背景与文字色上双重区分，避免容器/按钮双层边框的琐碎感。 */
const viewSwitch = css`
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  padding: 2px;
  border: none;
  border-radius: 6px;
  background: var(--bg);

  & > button {
    border: none;
    background: transparent;
    color: var(--text-secondary);
    padding: 3px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;

    &:hover {
      color: var(--text);
    }

    &[aria-pressed='true'] {
      background: var(--bg-secondary);
      color: var(--primary);
      font-weight: 600;
    }
  }
`

/* 调试用原始 JSON 视图：行尾次要小链接，不与主视图并列。 */
const viewJsonLink = css`
  border: none;
  background: none;
  padding: 3px 6px;
  font-size: 12px;
  color: var(--text-secondary);
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  border-radius: 4px;
  cursor: pointer;
  &:hover {
    color: var(--primary);
  }
  &[aria-pressed='true'] {
    color: var(--primary);
    font-weight: 600;
  }
`

const stream = css`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
  overflow-y: auto;
`

/* 底栏合并行：模型/工具选择 + 自动授权开关单行排布，替代原 footerBar/modeBar 两层。 */
const footerBar = css`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 4px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
  font-size: 12px;
`

/** auto 开启态的底栏：仅顶部 2px 警示细线提示状态（须在 footerBar 之后定义以按源序覆盖）。
 * 不再整条染橙——授权模式是持续状态而非错误，高饱和底色会长期压制消息流视觉。 */
const footerBarAuto = css`
  border-top: 2px solid color-mix(in srgb, var(--warning) 55%, transparent);
`

const footerLeft = css`
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  ${MOBILE} {
    /* 窄屏：Provider/Model 控件换行堆叠，避免 modelWrap 被 main 的
     * overflow:hidden 裁剪导致模型输入不可达；控件自身不超出容器。 */
    flex-wrap: wrap;
    & select,
    & input {
      max-width: 100%;
    }
  }
`

const footerRight = css`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-shrink: 0;
  ${MOBILE} {
    /* 窄屏：授权开关与警示 pill 换行独占，pill 允许截断不撑破容器 */
    flex-wrap: wrap;
    margin-left: 0;
    max-width: 100%;
    min-width: 0;
  }
`

const modeToggle = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  cursor: pointer;
  user-select: none;
  /* label 不受全局 44px 按钮约束，显式保证 ≥32px 紧凑触控热区下限（自动授权开关，触控安全关键） */
  min-height: 32px;
`

/** 关闭态中性说明：次级文本色，无警示语义。 */
const modeHint = css`
  color: var(--text-secondary);
`

/** 开启态警示 pill：描边淡底（--warning 前景 + 10% 底 + 45% 边框），短文案降噪，
 * 完整风险说明移入 title 悬停提示——状态可辨识但不长期抢占视觉权重。 */
const modeWarn = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  color: var(--warning);
  font-weight: 600;
  /* 窄屏换行后允许文本截断，不横向撑破底栏 */
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  bottomPanel,
  supportsVision = true,
  projectId,
  agents = [],
  emptyState,
}: ChatProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const streamRef = useRef<HTMLDivElement>(null)
  // 顶部滞留用户消息：滚动时钉住视口上方最近一条用户消息，支持点击跳转/上下导航。
  const stickyUserMessages = useMemo(
    () =>
      timeline
        .filter(
          (r): r is Extract<TimelineRow, { kind: 'message' }> =>
            r.kind === 'message' && r.message.role === 'user' && !isEmptyMessage(r.message),
        )
        .map((r) => ({ id: r.message.id, text: userMessageText(r.message) })),
    [timeline],
  )
  // 视图模式：同一份时间线数据的三种并列展示。
  //   chat  — 美化卡片；table — 平铺表格；json — 全量原始 JSON（含隐藏空壳消息）。
  const [viewMode, setViewMode] = useState<'chat' | 'table' | 'json'>('chat')
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在时间线长度变化时滚动，避免内容更新触发抖动
  useEffect(() => {
    if (viewMode === 'table') return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [timeline.length, viewMode])

  // steering 由 Composer 直接驱动：流式态下「追加指令」按钮/Enter 注入运行中消息。
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
      <div className={topBar} data-testid="view-bar">
        <div className={viewSwitch} role="group" aria-label="视图模式">
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
        </div>
        <div className={topSpacer} />
        {/* topStatus 单行截断仅是排布：错误全文经 title 悬停可达（usage 态无需） */}
        {error || usage ? (
          <span
            className={topStatus}
            style={error ? { color: 'var(--error)' } : undefined}
            title={error ?? undefined}
          >
            {error
              ? error
              : usage
                ? `${formatTokenCount(usage.input)} → ${formatTokenCount(usage.output)} tokens`
                : ''}
          </span>
        ) : null}
        {isStreaming && !paused ? (
          <button onClick={onPause} type="button" className={ctlBtn} data-testid="pause">
            暂停
          </button>
        ) : null}
        {isStreaming && paused ? (
          <button onClick={onResume} type="button" className={ctlBtn} data-testid="resume">
            恢复
          </button>
        ) : null}
        {isStreaming ? (
          <button
            onClick={onAbort}
            type="button"
            className={`${ctlBtn} ${ctlDanger}`}
            data-testid="abort"
          >
            中止
          </button>
        ) : null}
        <button
          type="button"
          className={viewJsonLink}
          aria-pressed={viewMode === 'json'}
          onClick={() => setViewMode('json')}
          data-testid="view-json"
          title="调试视图：完整时间线的原始 JSON"
        >
          原始 JSON
        </button>
      </div>
      {topPanel}
      {viewMode === 'table' ? (
        <TableView rows={timeline} />
      ) : (
        <div className={stream} data-testid="stream" ref={streamRef}>
          {viewMode === 'chat' && (
            <StickyUserMessage containerRef={streamRef} messages={stickyUserMessages} />
          )}
          {timeline.length === 0 && emptyState}
          <TimelineChat rows={timeline} showAllJson={viewMode === 'json'} />
          {isStreaming && <StreamingIndicator />}
          <div ref={bottomRef} />
        </div>
      )}
      {bottomPanel}
      <div
        className={permissionMode === 'auto' ? `${footerBar} ${footerBarAuto}` : footerBar}
        data-testid="permission-mode-bar"
      >
        {modelBar && <div className={footerLeft}>{modelBar}</div>}
        <div className={footerRight}>
          <label className={modeToggle}>
            <input
              type="checkbox"
              checked={permissionMode === 'auto'}
              onChange={togglePermissionMode}
              data-testid="permission-mode-toggle"
            />
            自动授权
          </label>
          {permissionMode === 'auto' ? (
            <span
              className={modeWarn}
              data-testid="permission-mode-warning"
              role="status"
              title="自动授权已开启：所有工具（含 bash）免确认执行"
            >
              ⚠ 自动授权已开启
            </span>
          ) : (
            <span className={modeHint} data-testid="permission-mode-hint">
              工具执行前逐个确认
            </span>
          )}
          {toolToggle}
        </div>
      </div>
      <Composer
        projectId={projectId}
        agents={agents}
        onSend={onSend}
        onAbort={onAbort}
        onSteer={onSteer}
        isStreaming={isStreaming}
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
