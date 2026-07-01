import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { LLMDetailsView } from '../components/LLMDetailsView.js'
import { type ModelSelection, ModelSelector } from '../components/ModelSelector.js'
import { SegmentBreakDialog } from '../components/SegmentBreakDialog.js'
import { SessionSummary } from '../components/SessionSummary.js'
import { mergeToolMessages } from '../components/session/utils/normalizeParts.js'
import { ToolToggle } from '../components/ToolToggle.js'
import { useConfig } from '../contexts/ConfigContext.js'
import { useAgent } from '../hooks/useAgent.js'
import { useChat } from '../hooks/useChat.js'
import { useMessages } from '../hooks/useSession.js'
import { providerAPI } from '../services/provider.js'
import { Chat, type SendPayload } from './Chat.js'

const empty = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 1;
  color: var(--text-secondary);
  font-size: 14px;
  padding: 24px;
  text-align: center;
`

const emptyIcon = css`
  font-size: 32px;
  opacity: 0.5;
`

/** 会话视图：无 sessionId 显示空状态，否则接通 useChat 进行流式对话。 */
export function ChatView({
  projectId,
  sessionId,
}: {
  projectId: string
  sessionId: string | null
}) {
  if (!sessionId) {
    return (
      <div className={empty}>
        <span className={emptyIcon}>💬</span>
        <span>选择一个会话或新建开始对话</span>
      </div>
    )
  }
  return <ChatSession projectId={projectId} sessionId={sessionId} />
}

function ChatSession({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const chat = useChat(sessionId)
  const agent = useAgent(sessionId)
  const { data: history } = useMessages(sessionId)
  const { config } = useConfig()
  const { data: providersData } = useQuery({
    queryKey: ['providers'],
    queryFn: () => providerAPI.list(),
    staleTime: 60_000,
  })

  const providers = providersData?.providers ?? []
  const [selection, setSelection] = useState<ModelSelection>({ provider: '', model: '' })

  // 校正默认 provider/model。registry 以 provider name 注册，而 defaultProvider
  // 可能是 protocol 名（如 openai-compat），直传会触发后端 NoRoute；故 defaultProvider
  // 不在已配置列表时回退首个已配置 provider。
  useEffect(() => {
    if (selection.provider && selection.model) return
    const def = providersData?.defaultProvider
    const provider = providers.some((p) => p.name === def)
      ? def
      : (providers[0]?.name ?? selection.provider)
    const model = config?.defaultModel ?? selection.model
    if (provider !== selection.provider || model !== selection.model) {
      setSelection({ provider: provider || selection.provider, model: model || selection.model })
    }
  }, [providers, providersData, config, selection.provider, selection.model])

  // 历史重载时，持久化层把同轮 assistant(tool_call) 与 tool(tool_result) 存成独立
  // Message；normalizeParts 只在单条 Message 内按 id 配对，不合并会导致历史工具调用
  // 渲染成两张卡（一张永久 running、一张孤立 result）。这里跨消息把 tool_result 并回
  // 对应 assistant，使历史与实时形态统一。实时 chat.messages 已在 reducer 内配对，no-op。
  const messages = useMemo(
    () => mergeToolMessages([...(history ?? []), ...chat.messages]),
    [history, chat.messages],
  )

  // 启用工具白名单：null = 默认全启用（不传 tools，走后端 config）；Set = 显式选择
  const [enabledTools, setEnabledTools] = useState<Set<string> | null>(null)

  const handleSend = (payload: SendPayload) => {
    // 新一轮发送：清除上轮残留的暂停态（paused 仅在运行中有意义）。
    agent.resetPaused()
    void chat.sendMessage(payload.text, {
      provider: selection.provider,
      model: selection.model,
      ...(enabledTools ? { tools: Array.from(enabledTools) } : {}),
      ...(payload.images.length ? { images: payload.images } : {}),
      ...(payload.files.length ? { files: payload.files } : {}),
    })
  }

  const handleConfirm = (toolCallId: string, approved: boolean) => {
    chat.confirm(toolCallId, approved)
  }

  // TODO: 从当前选中 model 的 capabilities 读取 supportsVision（providersData 已含）
  const supportsVision = true

  return (
    <>
      <Chat
        projectId={projectId}
        messages={messages}
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
        modelBar={<ModelSelector value={selection} onChange={setSelection} />}
        toolToggle={
          <ToolToggle
            enabled={enabledTools}
            onChange={setEnabledTools}
            disabled={chat.isStreaming}
          />
        }
        topPanel={
          <>
            <SessionSummary sessionId={sessionId} />
            <LLMDetailsView sessionId={sessionId} />
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
    </>
  )
}
