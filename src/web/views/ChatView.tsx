import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { LLMDetailsView } from '../components/LLMDetailsView.js'
import { type ModelSelection, ModelSelector } from '../components/ModelSelector.js'
import { SessionSummary } from '../components/SessionSummary.js'
import { ToolToggle } from '../components/ToolToggle.js'
import { useConfig } from '../contexts/ConfigContext.js'
import { useChat } from '../hooks/useChat.js'
import { useMessages } from '../hooks/useSession.js'
import { agentAPI } from '../services/agent.js'
import { providerAPI } from '../services/provider.js'
import { Chat } from './Chat.js'

const empty = css`
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  font-size: 14px;
  padding: 24px;
  text-align: center;
`

/** 会话视图：无 sessionId 显示空状态，否则接通 useChat 进行流式对话。 */
export function ChatView({ sessionId }: { sessionId: string | null }) {
  if (!sessionId) {
    return <div className={empty}>从左侧选择或新建一个会话开始对话</div>
  }
  return <ChatSession sessionId={sessionId} />
}

function ChatSession({ sessionId }: { sessionId: string }) {
  const chat = useChat(sessionId)
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

  const messages = useMemo(() => [...(history ?? []), ...chat.messages], [history, chat.messages])

  // 启用工具白名单：null = 默认全启用（不传 tools，走后端 config）；Set = 显式选择
  const [enabledTools, setEnabledTools] = useState<Set<string> | null>(null)

  const handleSend = (text: string) => {
    void chat.sendMessage(text, {
      provider: selection.provider,
      model: selection.model,
      ...(enabledTools ? { tools: Array.from(enabledTools) } : {}),
    })
  }

  const handleConfirm = (toolCallId: string, approved: boolean) => {
    agentAPI
      .confirmTool(toolCallId, approved)
      .catch((err) => console.error('[权限确认] 失败，工具调用可能已过期:', err))
  }

  return (
    <Chat
      messages={messages}
      isStreaming={chat.isStreaming}
      usage={chat.usage}
      error={chat.error}
      pendingPermission={chat.pendingPermission}
      onSend={handleSend}
      onAbort={chat.abort}
      onConfirm={handleConfirm}
      modelBar={<ModelSelector value={selection} onChange={setSelection} />}
      toolToggle={
        <ToolToggle enabled={enabledTools} onChange={setEnabledTools} disabled={chat.isStreaming} />
      }
      topPanel={
        <>
          <SessionSummary sessionId={sessionId} />
          <LLMDetailsView sessionId={sessionId} />
        </>
      }
    />
  )
}
