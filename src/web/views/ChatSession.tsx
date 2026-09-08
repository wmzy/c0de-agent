// src/web/views/ChatSession.tsx
// 有会话 id 的聊天页：统一时间线、Shake 模式、中断恢复。
// 从 ChatView.tsx 拆出（2026-09），样式与状态只服务于本组件。

import { css } from '@linaria/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AgentSelector } from '../components/AgentSelector.js'
import { ArchivePanel } from '../components/ArchivePanel.js'
import { ModelSelector } from '../components/ModelSelector.js'
import { SegmentBreakDialog } from '../components/SegmentBreakDialog.js'
import { SessionSummary } from '../components/SessionSummary.js'
import { type ShakeModeValue, ShakeProvider } from '../components/session/ShakeContext.js'
import { mergeToolMessages } from '../components/session/utils/normalizeParts.js'
import { buildTimeline } from '../components/session/utils/timeline.js'
import { TodoPanel } from '../components/TodoPanel.js'
import { ToolToggle } from '../components/ToolToggle.js'
import { pendingFirstMessage } from '../hooks/pendingFirstMessage.js'
import { useAgent } from '../hooks/useAgent.js'
import { useChat } from '../hooks/useChat.js'
import { useComposerDefaults } from '../hooks/useComposerDefaults.js'
import { useMessages } from '../hooks/useSession.js'
import { agentAPI } from '../services/agent.js'
import { providerAPI } from '../services/provider.js'
import { sessionAPI } from '../services/session.js'
import type { ShakeRegionView } from '../types/index.js'
import { Chat, type SendPayload } from './Chat.js'
import { ChatSkeleton, ChatWelcome, SetupBanner } from './ChatView.js'

const interruptBanner = css`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  font-size: 13px;
  color: var(--text-secondary);

  & > button {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 3px 12px;
    cursor: pointer;
    font-size: 12px;
    background: var(--bg);
    color: var(--text);

    &:first-of-type {
      border-color: var(--primary);
      color: var(--primary);
    }
  }
`

const shakeBtn = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;

  &:hover {
    background: var(--bg-secondary);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`

const shakeToolbar = css`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 10px;
  border: 1px solid color-mix(in srgb, var(--warning) 50%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--warning) 8%, transparent);
  font-size: 12px;
  color: var(--warning);

  & > span {
    color: var(--text-secondary);
  }

  & > button {
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 8px;
    font-size: 11px;
    cursor: pointer;
    background: var(--bg);
    color: var(--text);

    &:hover {
      background: var(--bg-secondary);
    }

    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
  }
`

const shakeExitBtn = css`
  border: none !important;
  background: transparent !important;
  color: var(--text-secondary) !important;
  padding: 0 4px !important;

  &:hover {
    color: var(--text) !important;
  }
`

export function ChatSession({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const chat = useChat(sessionId)
  const agent = useAgent(sessionId)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: history, isLoading } = useMessages(sessionId)
  const { selection, setSelection, enabledTools, setEnabledTools, agentName, setAgentName } =
    useComposerDefaults(projectId)
  // P2-3：会话归属校验——URL 与会话所属项目不一致时跳转到正确项目；
  // 会话无归属（孤儿）时提供归属到当前项目的入口。
  const { data: sessionMeta } = useQuery({
    queryKey: ['session', sessionId, 'meta'],
    queryFn: () => sessionAPI.get(sessionId),
  })
  const [orphanNotice, setOrphanNotice] = useState(false)
  const rebindToCurrent = useMutation({
    mutationFn: () => sessionAPI.rebind(sessionId, projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions', 'tree'] })
      qc.invalidateQueries({ queryKey: ['session', sessionId, 'meta'] })
      setOrphanNotice(false)
    },
  })
  useEffect(() => {
    if (!sessionMeta) return
    if (sessionMeta.projectId && sessionMeta.projectId !== projectId) {
      navigate(`/projects/${sessionMeta.projectId}/sessions/${sessionId}`, { replace: true })
    } else if (!sessionMeta.projectId) {
      setOrphanNotice(true)
    }
  }, [sessionMeta, projectId, sessionId, navigate])
  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentAPI.listAgents(),
    staleTime: 60_000,
  })
  // 草稿页 pending 首条消息仅消费一次（ref 防 StrictMode 双调用）
  const consumed = useRef(false)

  // 冷启动中断/暂停检测：页面加载时检查 session status，若上次 run 未正常结束则显示恢复提示。
  // 同时记录打开时间，用于会话列表按最近打开排序。
  const [coldStartInterrupted, setColdStartInterrupted] = useState(false)
  const [coldStartPaused, setColdStartPaused] = useState(false)
  useEffect(() => {
    setColdStartInterrupted(false)
    setColdStartPaused(false)
    sessionAPI
      .status(sessionId)
      .then((s) => {
        if (s._tag === 'interrupted') setColdStartInterrupted(true)
        else if (s._tag === 'paused') setColdStartPaused(true)
      })
      .catch(() => {})
    // 记录打开时间并刷新会话树（排序依据 lastOpenedAt）
    sessionAPI
      .open(sessionId)
      .then(() => qc.invalidateQueries({ queryKey: ['sessions', 'tree'] }))
      .catch(() => {})
  }, [sessionId, qc])

  // P1：附着后台 run——挂起期间切换页面后回来 / 刷新时，重挂权限弹窗并显示运行态，
  // 消除「权限弹窗挂起 + 导航离开 = 会话锁死无 UI 可恢复」的死角。
  // attach 经 useCallback 稳定且随 sessionId 重建，直接作为唯一依赖。
  useEffect(() => {
    void chat.attach()
  }, [chat.attach])

  const showInterruptBanner = coldStartInterrupted || chat.interrupted

  // 历史重载时，持久化层把同轮 assistant(tool_call) 与 tool(tool_result) 存成独立
  // Message；normalizeParts 只在单条 Message 内按 id 配对，不合并会导致历史工具调用
  // 渲染成两张卡（一张永久 running、一张孤立 result）。这里跨消息把 tool_result 并回
  // 对应 assistant，使历史与实时形态统一。实时 chat.messages 已在 reducer 内配对，no-op。
  const messages = useMemo(
    () => mergeToolMessages([...(history ?? []), ...chat.messages]),
    [history, chat.messages],
  )

  // LLM 调用段：llm_detail 事件会 invalidate 此 query（见 useChat），实时刷新。
  const { data: segments } = useQuery({
    queryKey: ['session', sessionId, 'llm-details'],
    queryFn: () => sessionAPI.llmDetails(sessionId),
    staleTime: 10_000,
  })

  // 统一时间线：消息 + LLM 调用 + 段标记按时间交错融合。
  const timeline = useMemo(() => buildTimeline(messages, segments ?? []), [messages, segments])

  // 消费草稿页暂存的首条消息：导航到新会话后自动发送，并恢复 model/工具选择。
  // 仅按 sessionId 消费一次；sendMessage/setSelection/setEnabledTools 在本实例内稳定，故不纳入依赖。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 草稿 pending 仅按 sessionId 消费一次
  useEffect(() => {
    if (consumed.current) return
    const pending = pendingFirstMessage.get(sessionId)
    if (!pending) return
    consumed.current = true
    pendingFirstMessage.delete(sessionId)
    // 恢复时若 pending.opts 无 agent，用当前 agentName
    if (!pending.opts.agent) pending.opts.agent = agentName
    if (pending.opts.provider && pending.opts.model) {
      setSelection({ provider: pending.opts.provider, model: pending.opts.model })
    }
    if (pending.opts.tools) setEnabledTools(new Set(pending.opts.tools))
    void chat.sendMessage(pending.text, pending.opts).then((ok) => {
      void cleanupEmptySessionOnFailure(ok, true)
    })
  }, [sessionId])

  // 启用工具白名单：null = 默认全启用（不传 tools，走后端 config）；Set = 显式选择
  const handleSend = (payload: SendPayload) => {
    // 新一轮发送：清除上轮残留的暂停态（paused 仅在运行中有意义）。
    agent.resetPaused()
    const firstMessage = messages.length === 0
    void chat
      .sendMessage(payload.text, {
        provider: selection.provider,
        model: selection.model,
        agent: agentName,
        ...(enabledTools ? { tools: Array.from(enabledTools) } : {}),
        ...(payload.images.length ? { images: payload.images } : {}),
        ...(payload.files.length ? { files: payload.files } : {}),
        ...(payload.agents.length ? { agents: payload.agents } : {}),
      })
      .then((ok) => {
        void cleanupEmptySessionOnFailure(ok, firstMessage)
      })
  }

  const handleConfirm = (toolCallId: string, approved: boolean, alwaysAllow?: boolean) => {
    chat.confirm(toolCallId, approved, alwaysAllow ? chat.pendingPermission?.tool : undefined)
  }

  /** 首条消息发送失败（未配 provider/网络中断且无持久化消息）→ 删除空会话回草稿页，
   *  避免每次失败尝试在会话树里留下空「New Session」堆积（P3 空会话治理）。 */
  const cleanupEmptySessionOnFailure = async (ok: boolean, firstMessage: boolean) => {
    if (ok || !firstMessage) return
    try {
      const msgs = await sessionAPI.messages(sessionId)
      if (msgs.length === 0) {
        await sessionAPI.remove(sessionId)
        qc.invalidateQueries({ queryKey: ['sessions'] })
        qc.invalidateQueries({ queryKey: ['sessions', 'tree'] })
        navigate(`/projects/${projectId}`)
      }
    } catch {
      // 清理失败不阻塞：会话树里至多多一个空会话，可手动删除
    }
  }

  // shake 内联模式状态
  const [shakeMode, setShakeMode] = useState(false)
  const [shakeRegions, setShakeRegions] = useState<ShakeRegionView[]>([])
  const [shakeSelected, setShakeSelected] = useState<Set<string>>(new Set())
  const shakeMutation = useMutation({
    mutationFn: (regionIds: string[]) => sessionAPI.shakeApply(sessionId, regionIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', sessionId, 'messages'] })
      exitShakeMode()
    },
  })

  const exitShakeMode = () => {
    setShakeMode(false)
    setShakeRegions([])
    setShakeSelected(new Set())
  }

  // 归档面板开关
  const [showArchives, setShowArchives] = useState(false)

  // 会话导出：下载 JSON（元数据 + 消息 + 归档），数据可迁移（改进建议 #4）。
  // P0 明示：导出仅含本会话消息与归档，fork 分支/子会话不在其中——有分支时
  // 导出前确认告知（此前用户以为完整备份，分支关系静默丢失）。
  const handleExport = async () => {
    try {
      const [data, branches] = await Promise.all([
        sessionAPI.exportSession(sessionId),
        sessionAPI.branches(sessionId).catch(() => []),
      ])
      if (branches.length > 0) {
        const ok = window.confirm(
          `该会话有 ${branches.length} 个派生分支。导出仅包含本会话的消息与归档，分支内容不会导出。\n确定继续导出本会话？`,
        )
        if (!ok) return
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const title = (data.session.title || 'session').replace(/[^\w\u4e00-\u9fff-]+/g, '_')
      a.href = url
      a.download = `${title}.c0de-session.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      // 导出失败静默：不阻塞主界面（可重试）
    }
  }

  const handleShakeOpen = async () => {
    try {
      const result = await sessionAPI.shakePreview(sessionId)
      setShakeRegions(result.regions)
      setShakeSelected(
        new Set(result.regions.filter((r) => r.isAfterProtectWindow).map((r) => r.id)),
      )
      setShakeMode(true)
    } catch {
      // 静默失败，不阻塞用户
    }
  }

  const shakeToggle = useCallback((id: string) => {
    setShakeSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const regionsByMessage = useMemo(() => {
    // tool_result 在 DB 中是独立 role:'tool' 消息，前端 mergeToolMessages 合并进 assistant
    // 后该消息被 drop。region.messageId 指向被 drop 的 tool 消息；用 toolCallId 重映射到
    // 含 tool_call 的 assistant 消息，block region 的 messageId 本就是 assistant。
    const callIdToMsgId = new Map<string, string>()
    for (const m of messages) {
      for (const part of m.content) {
        if (part._tag === 'tool_call') callIdToMsgId.set(part.id, m.id)
      }
    }
    const map = new Map<string, ShakeRegionView[]>()
    for (const r of shakeRegions) {
      const targetMsgId =
        r.kind === 'toolResult' && r.toolCallId
          ? (callIdToMsgId.get(r.toolCallId) ?? r.messageId)
          : r.messageId
      const list = map.get(targetMsgId) ?? []
      list.push(r)
      map.set(targetMsgId, list)
    }
    return map
  }, [shakeRegions, messages])

  const shakeContextValue: ShakeModeValue = useMemo(
    () => ({
      enabled: shakeMode,
      regionsByMessage,
      selected: shakeSelected,
      onToggle: shakeToggle,
    }),
    [shakeMode, regionsByMessage, shakeSelected, shakeToggle],
  )

  const shakeSelectedTokens = shakeRegions
    .filter((r) => shakeSelected.has(r.id))
    .reduce((sum, r) => sum + r.tokens, 0)

  // 恢复中断的对话：从 DB 重载消息，若末尾是 user 消息则重发（后端幂等跳过 append）。
  // P0：steering 条目在 /messages 中以 user 角色返回但仅含 steering part——重发扫描
  // 需跳过它们，否则中断恰发生在追加指令后时 resume 静默失效。
  const handleResume = async () => {
    setColdStartInterrupted(false)
    chat.clearInterrupted()
    // 清空内存流式消息：中断前的乐观副本（user 消息/steering）与即将重载的
    // DB 消息合并会重复渲染（同一类既有缺陷随 steering 持久化显性化）。
    chat.reset()
    const msgs = await sessionAPI.messages(sessionId)
    qc.setQueryData(['session', sessionId, 'messages'], msgs)
    const lastUserWithText = [...msgs]
      .reverse()
      .find((m) => m.role === 'user' && m.content.some((p) => p._tag === 'text'))
    if (lastUserWithText) {
      const text = lastUserWithText.content
        .filter((p) => p._tag === 'text')
        .map((p) => (p._tag === 'text' ? p.text : ''))
        .join('')
      if (text) {
        const session = await sessionAPI.get(sessionId)
        const lr = session.metadata.lastRun
        await chat.retry(text, {
          ...(lr?.provider ? { provider: lr.provider } : { provider: selection.provider }),
          ...(lr?.model ? { model: lr.model } : { model: selection.model }),
          ...(lr?.agentName ? { agent: lr.agentName } : { agent: agentName }),
        })
      }
    }
  }

  // 视觉能力按选中模型查询（provider/model capabilities）：不支持视觉的模型隐藏图片入口，
  // 避免贴图后 provider 直接 400（P3 一致性）。
  const { data: capabilitiesData } = useQuery({
    queryKey: ['capabilities', selection.provider, selection.model],
    queryFn: () => providerAPI.capabilities(selection.provider, selection.model),
    enabled: Boolean(selection.provider && selection.model),
    staleTime: 60_000,
    retry: false,
  })
  const supportsVision = capabilitiesData?.supportsVision ?? true

  if (isLoading && messages.length === 0) return <ChatSkeleton />

  return (
    <ShakeProvider value={shakeContextValue}>
      <Chat
        projectId={projectId}
        sessionId={sessionId}
        agents={agentsData?.agents ?? []}
        timeline={timeline}
        isStreaming={chat.isStreaming}
        usage={chat.usage}
        error={chat.error}
        pendingPermission={chat.pendingPermission}
        permissionTimeout={chat.permissionTimeout}
        onReopenPermission={chat.reopenPermission}
        onDenyTimedOutPermission={chat.denyTimedOutPermission}
        onSend={handleSend}
        onAbort={chat.abort}
        onConfirm={handleConfirm}
        onPause={agent.pause}
        onResume={agent.resume}
        onSteer={chat.steer}
        paused={agent.paused}
        supportsVision={supportsVision}
        emptyState={<ChatWelcome />}
        modelBar={
          <>
            <AgentSelector
              value={agentName}
              onChange={setAgentName}
              agents={agentsData?.agents ?? []}
            />
            <ModelSelector value={selection} onChange={setSelection} projectId={projectId} />
          </>
        }
        toolToggle={
          <ToolToggle
            enabled={enabledTools}
            onChange={setEnabledTools}
            disabled={chat.isStreaming}
          />
        }
        bottomPanel={<TodoPanel sessionId={sessionId} projectId={projectId} />}
        topPanel={
          <>
            <SetupBanner projectId={projectId} />
            {orphanNotice && (
              <div className={interruptBanner} data-testid="orphan-session-banner">
                <span>
                  该会话未归属任何项目（原项目已删除），无法执行工具。归属到当前项目后可继续使用。
                </span>
                <button
                  type="button"
                  onClick={() => rebindToCurrent.mutate()}
                  disabled={rebindToCurrent.isPending}
                >
                  归属到当前项目
                </button>
              </div>
            )}
            {showInterruptBanner && !chat.isStreaming && (
              <div className={interruptBanner} data-testid="interrupt-banner">
                <span>
                  连接已中断（服务可能已重启）。恢复将重发上一条消息，已执行的工具可能重复执行
                </span>
                <button
                  onClick={() => void handleResume()}
                  type="button"
                  title="重发上一条消息继续；中断前已执行的工具（bash/git 等）可能再次执行"
                >
                  恢复对话
                </button>
                <button
                  onClick={() => {
                    setColdStartInterrupted(false)
                    chat.clearInterrupted()
                  }}
                  type="button"
                >
                  忽略
                </button>
              </div>
            )}
            {chat.attachedRun && (
              <div className={interruptBanner} data-testid="attached-run-banner">
                <span>
                  对话正在运行中（可能在其他标签页启动，或挂起期间切换了页面）。完成后自动刷新。
                </span>
                <button onClick={() => chat.abort()} type="button" title="中止后台运行中的对话">
                  中止
                </button>
              </div>
            )}
            {chat.compactionNotice && (
              <div className={interruptBanner} data-testid="compaction-notice-banner">
                <span>{chat.compactionNotice}</span>
                <button onClick={() => chat.clearCompactionNotice()} type="button" title="关闭提示">
                  知道了
                </button>
              </div>
            )}
            {coldStartPaused && !chat.isStreaming && (
              <div className={interruptBanner} data-testid="paused-banner">
                <span>对话处于暂停状态，可继续执行</span>
                <button
                  onClick={() => {
                    // 活跃 run 仍注册在服务端（页面刷新场景），resume 端点可真正恢复；
                    // 服务重启导致的 paused 已由 status 端点转为 interrupted（走重发路径）。
                    setColdStartPaused(false)
                    agent.resume()
                  }}
                  type="button"
                >
                  继续对话
                </button>
                <button
                  onClick={() => {
                    setColdStartPaused(false)
                    chat.clearInterrupted()
                  }}
                  type="button"
                >
                  忽略
                </button>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, padding: '4px 12px' }}>
              {shakeMode ? (
                <div className={shakeToolbar} data-testid="shake-toolbar">
                  <span>⚡ Shake 模式</span>
                  <span>
                    已选 {shakeSelected.size}/{shakeRegions.length} · 省 {shakeSelectedTokens}t
                  </span>
                  <button
                    type="button"
                    onClick={() => setShakeSelected(new Set(shakeRegions.map((r) => r.id)))}
                    data-testid="shake-select-all"
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    onClick={() => setShakeSelected(new Set())}
                    data-testid="shake-deselect-all"
                  >
                    取消全选
                  </button>
                  <button
                    type="button"
                    onClick={() => shakeMutation.mutate([...shakeSelected])}
                    disabled={shakeSelected.size === 0}
                    data-testid="shake-submit"
                  >
                    提交 Shake
                  </button>
                  <button
                    type="button"
                    className={shakeExitBtn}
                    onClick={exitShakeMode}
                    data-testid="shake-exit"
                    aria-label="退出 Shake"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className={shakeBtn}
                  onClick={() => void handleShakeOpen()}
                  disabled={chat.isStreaming}
                  data-testid="shake-button"
                >
                  ⚡ Shake
                </button>
              )}
              <button
                type="button"
                className={shakeBtn}
                onClick={() => setShowArchives(true)}
                data-testid="archive-button"
                title="查看 /clear、Shake、压缩归档的原始内容"
              >
                归档
              </button>
              <button
                type="button"
                className={shakeBtn}
                onClick={() => void handleExport()}
                data-testid="export-button"
                title="导出会话（消息 + 归档）为 JSON 文件"
              >
                导出
              </button>
              <SessionSummary sessionId={sessionId} />
            </div>
          </>
        }
      />
      {chat.pendingSegmentBreak && (
        <SegmentBreakDialog
          activeSegment={chat.pendingSegmentBreak.activeSegment}
          onConfirm={() => void chat.confirmBreak(false)}
          onCompact={() => void chat.confirmBreak(true)}
          onCancel={() => {
            // 取消：还原 selection/enabledTools 到活跃段值，再清除待发状态
            const seg = chat.pendingSegmentBreak?.activeSegment
            if (seg) {
              setSelection({ provider: seg.provider, model: seg.model })
              setEnabledTools(new Set(seg.tools))
            }
            chat.cancelBreak()
          }}
        />
      )}
      {showArchives && (
        <ArchivePanel sessionId={sessionId} onClose={() => setShowArchives(false)} />
      )}
    </ShakeProvider>
  )
}
