import { css } from '@linaria/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AgentSelector } from '../components/AgentSelector.js'
import { ModelSelector } from '../components/ModelSelector.js'
import { SegmentBreakDialog } from '../components/SegmentBreakDialog.js'
import { SessionSummary } from '../components/SessionSummary.js'
import { ShakeProvider, type ShakeModeValue } from '../components/session/ShakeContext.js'
import { mergeToolMessages } from '../components/session/utils/normalizeParts.js'
import { buildTimeline } from '../components/session/utils/timeline.js'
import { ToolToggle } from '../components/ToolToggle.js'
import { pendingFirstMessage } from '../hooks/pendingFirstMessage.js'
import { useAgent } from '../hooks/useAgent.js'
import { useChat } from '../hooks/useChat.js'
import { useComposerDefaults } from '../hooks/useComposerDefaults.js'
import { useMessages, useProjects } from '../hooks/useSession.js'
import { agentAPI } from '../services/agent.js'
import { sessionAPI } from '../services/session.js'
import type { ShakeRegionView } from '../types/index.js'
import { Chat, type SendPayload } from './Chat.js'

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

/**
 * 会话视图：
 * - sessionId === null：草稿新会话页，渲染带输入框的 Chat，发送首条消息时才创建会话。
 * - 否则接通 useChat 进行流式对话；若来自草稿页的 pending 首条消息则自动发送。
 */
export function ChatView({
  projectId,
  sessionId,
}: {
  projectId: string
  sessionId: string | null
}) {
  if (!sessionId) return <DraftSession projectId={projectId} />
  return <ChatSession projectId={projectId} sessionId={sessionId} />
}

/**
 * 草稿新会话页：不创建会话，仅渲染输入区。发送首条消息时创建会话，
 * 把消息暂存到 pendingFirstMessage，再导航到新会话路由交由 ChatSession 发送，
 * 从而保证 SSE 流在拥有真实 sessionId 的组件实例中建立，不会被卸载中断。
 */
function DraftSession({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data: projects } = useProjects()
  const projectName = projects?.find((p) => p.id === projectId)?.name ?? undefined
  const { selection, setSelection, enabledTools, setEnabledTools, agentName, setAgentName } =
    useComposerDefaults()
  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentAPI.listAgents(),
    staleTime: 60_000,
  })
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSend = async (payload: SendPayload) => {
    setError(null)
    setCreating(true)
    const opts = {
      provider: selection.provider,
      model: selection.model,
      agent: agentName,
      ...(enabledTools ? { tools: Array.from(enabledTools) } : {}),
      ...(payload.images.length ? { images: payload.images } : {}),
      ...(payload.files.length ? { files: payload.files } : {}),
      ...(payload.agents.length ? { agents: payload.agents } : {}),
    }
    try {
      const session = await sessionAPI.create({ projectId })
      pendingFirstMessage.set(session.id, { text: payload.text, opts })
      // 让侧边栏立即显示新会话
      qc.invalidateQueries({ queryKey: ['sessions'] })
      navigate(`/projects/${projectId}/sessions/${session.id}`)
    } catch {
      setCreating(false)
      setError('创建会话失败，请重试')
    }
  }

  return (
    <Chat
      projectId={projectId}
      projectName={projectName}
      agents={agentsData?.agents ?? []}
      timeline={[]}
      isStreaming={creating}
      usage={null}
      error={error}
      pendingPermission={null}
      onSend={handleSend}
      onAbort={() => {
        /* 草稿阶段无可中止的后端请求 */
      }}
      onConfirm={() => {}}
      modelBar={
        <>
          <AgentSelector
            value={agentName}
            onChange={setAgentName}
            agents={agentsData?.agents ?? []}
          />
          <ModelSelector value={selection} onChange={setSelection} />
        </>
      }
      toolToggle={
        <ToolToggle enabled={enabledTools} onChange={setEnabledTools} disabled={creating} />
      }
      supportsVision
    />
  )
}

function ChatSession({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const chat = useChat(sessionId)
  const agent = useAgent(sessionId)
  const qc = useQueryClient()
  const { data: history } = useMessages(sessionId)
  const { data: projects } = useProjects()
  const projectName = projects?.find((p) => p.id === projectId)?.name ?? undefined
  const { selection, setSelection, enabledTools, setEnabledTools, agentName, setAgentName } =
    useComposerDefaults()
  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentAPI.listAgents(),
    staleTime: 60_000,
  })
  // 草稿页 pending 首条消息仅消费一次（ref 防 StrictMode 双调用）
  const consumed = useRef(false)

  // 冷启动中断检测：页面加载时检查 session status，若上次 run 未正常结束则显示恢复提示
  const [coldStartInterrupted, setColdStartInterrupted] = useState(false)
  useEffect(() => {
    setColdStartInterrupted(false)
    sessionAPI
      .status(sessionId)
      .then((s) => {
        if (s._tag === 'interrupted') setColdStartInterrupted(true)
      })
      .catch(() => {})
  }, [sessionId])

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
    void chat.sendMessage(pending.text, pending.opts)
  }, [sessionId])

  // 启用工具白名单：null = 默认全启用（不传 tools，走后端 config）；Set = 显式选择
  const handleSend = (payload: SendPayload) => {
    // 新一轮发送：清除上轮残留的暂停态（paused 仅在运行中有意义）。
    agent.resetPaused()
    void chat.sendMessage(payload.text, {
      provider: selection.provider,
      model: selection.model,
      agent: agentName,
      ...(enabledTools ? { tools: Array.from(enabledTools) } : {}),
      ...(payload.images.length ? { images: payload.images } : {}),
      ...(payload.files.length ? { files: payload.files } : {}),
      ...(payload.agents.length ? { agents: payload.agents } : {}),
    })
  }

  const handleConfirm = (toolCallId: string, approved: boolean) => {
    chat.confirm(toolCallId, approved)
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

  const shakeToggle = (id: string) => {
    setShakeSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
    () => ({ enabled: shakeMode, regionsByMessage, selected: shakeSelected, onToggle: shakeToggle }),
    [shakeMode, regionsByMessage, shakeSelected],
  )

  const shakeSelectedTokens = shakeRegions
    .filter((r) => shakeSelected.has(r.id))
    .reduce((sum, r) => sum + r.tokens, 0)

  // 恢复中断的对话：从 DB 重载消息，若末尾是 user 消息则重发（后端幂等跳过 append）
  const handleResume = async () => {
    setColdStartInterrupted(false)
    chat.clearInterrupted()
    const msgs = await sessionAPI.messages(sessionId)
    qc.setQueryData(['session', sessionId, 'messages'], msgs)
    const lastMsg = msgs[msgs.length - 1]
    if (lastMsg?.role === 'user') {
      const text = lastMsg.content
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

  // TODO: 从当前选中 model 的 capabilities 读取 supportsVision（providersData 已含）
  const supportsVision = true

  return (
    <ShakeProvider value={shakeContextValue}>
      <Chat
        projectId={projectId}
        projectName={projectName}
        agents={agentsData?.agents ?? []}
        timeline={timeline}
        isStreaming={chat.isStreaming}
        usage={chat.usage}
        error={chat.error}
        pendingPermission={chat.pendingPermission}
        onSend={handleSend}
        onAbort={chat.abort}
        onConfirm={handleConfirm}
        onPause={agent.pause}
        onResume={agent.resume}
        onSteer={agent.steer}
        paused={agent.paused}
        supportsVision={supportsVision}
        modelBar={
          <>
            <AgentSelector
              value={agentName}
              onChange={setAgentName}
              agents={agentsData?.agents ?? []}
            />
            <ModelSelector value={selection} onChange={setSelection} />
          </>
        }
        toolToggle={
          <ToolToggle
            enabled={enabledTools}
            onChange={setEnabledTools}
            disabled={chat.isStreaming}
          />
        }
        topPanel={
          <>
            {showInterruptBanner && !chat.isStreaming && (
              <div className={interruptBanner} data-testid="interrupt-banner">
                <span>连接已中断（服务可能已重启）</span>
                <button onClick={() => void handleResume()} type="button">
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
    </ShakeProvider>
  )
}
