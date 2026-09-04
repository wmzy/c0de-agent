import { css } from '@linaria/core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AgentSelector } from '../components/AgentSelector.js'
import { Logo } from '../components/Logo.js'
import { ModelSelector } from '../components/ModelSelector.js'
import { ToolToggle } from '../components/ToolToggle.js'
import { useConfig } from '../contexts/ConfigContext.js'
import { useFileReference } from '../contexts/ReferenceContext.js'
import { pendingFirstMessage } from '../hooks/pendingFirstMessage.js'
import { useComposerDefaults } from '../hooks/useComposerDefaults.js'
import { agentAPI } from '../services/agent.js'
import { sessionAPI } from '../services/session.js'
import { Chat, type SendPayload } from './Chat.js'
import { ChatSession } from './ChatSession.js'

/** P0-1：未配置 AI 服务的引导横幅（欢迎区上方，直达设置页）。 */
const setupBanner = css`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  font-size: 13px;
  color: var(--text);

  & > a {
    color: var(--primary);
    text-decoration: none;
    border: 1px solid var(--primary);
    border-radius: 6px;
    padding: 3px 12px;
    font-size: 12px;
    flex-shrink: 0;
    &:hover {
      background: color-mix(in srgb, var(--primary) 10%, transparent);
    }
  }
`

/** 未配置 provider 时的引导横幅（首条消息前展示）。 */
export function SetupBanner() {
  const { config, loading } = useConfig()
  if (loading || !config) return null
  const hasProvider = (config.providers ?? []).length > 0
  if (hasProvider) return null
  return (
    <div className={setupBanner} data-testid="setup-banner">
      <span>尚未配置 AI 服务（Provider / API Key），无法开始对话</span>
      <Link to="/settings">去设置</Link>
    </div>
  )
}

const skeletonStream = css`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  overflow-y: auto;
`

const skeletonBar = css`
  height: 12px;
  border-radius: 6px;
  background: var(--bg-secondary);
  animation: skeletonPulse 1.5s ease-in-out infinite;

  @keyframes skeletonPulse {
    0%,
    100% {
      opacity: 0.45;
    }
    50% {
      opacity: 1;
    }
  }
`

const welcomeWrap = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  padding: 24px 16px 32px;
  /* margin-block:auto 吸收滚动容器剩余空间实现居中；内容超高时不像 justify-content:center 那样裁掉顶部 */
  margin-block: auto;
`

const welcomeSub = css`
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  text-align: center;
`

const exampleGrid = css`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 220px));
  gap: 10px;
  justify-content: center;
  width: 100%;
  max-width: 480px;
`

const exampleCard = css`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.12s ease, background-color 0.12s ease, transform 0.12s ease,
    box-shadow 0.12s ease;

  &:hover {
    background: var(--bg-secondary);
    border-color: color-mix(in srgb, var(--primary) 40%, var(--border));
    transform: translateY(-1px);
    box-shadow: var(--shadow);
  }

  &:active {
    transform: translateY(0);
    box-shadow: none;
  }
`

const cardTitle = css`
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
`

const cardDesc = css`
  font-size: 12px;
  color: var(--text-secondary);
`

const welcomeHint = css`
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
`

/** 空会话示例任务卡片：title 是卡片标签，prompt 是点击后填入 composer 的文本。 */
export const EXAMPLE_TASKS = [
  {
    title: '解释这个项目的架构',
    desc: '梳理模块、数据流与关键设计',
    prompt: '解释这个项目的架构：主要模块、数据流和关键设计决策',
  },
  {
    title: '为当前项目修一个 bug',
    desc: '定位根因，修复并补回归测试',
    prompt: '帮我修一个 bug：先定位根因，修复后补充回归测试验证',
  },
  {
    title: '写一个新功能并补测试',
    desc: '实现功能，一步到位补单测',
    prompt: '帮我实现一个新功能，完成后补充对应的单元测试',
  },
  {
    title: '审查最近的改动',
    desc: '检查最近提交，指出问题',
    prompt: '审查最近一次提交的改动，指出问题并给出改进建议',
  },
]

/** 空会话欢迎区：应用名 + 欢迎语 + 示例任务卡片 + 能力提示。
 *  点击卡片经 ReferenceContext 把示例文本填入 composer 并聚焦。 */
export function ChatWelcome() {
  const fileRef = useFileReference()
  return (
    <div className={welcomeWrap} data-testid="chat-welcome">
      <Logo />
      <p className={welcomeSub}>描述你想做的事，我会读代码、改文件、跑命令，直到完成</p>
      <div className={exampleGrid}>
        {EXAMPLE_TASKS.map((task) => (
          <button
            key={task.title}
            type="button"
            className={exampleCard}
            data-testid="welcome-card"
            onClick={() => fileRef?.insertPromptText?.(task.prompt)}
          >
            <span className={cardTitle}>{task.title}</span>
            <span className={cardDesc}>{task.desc}</span>
          </button>
        ))}
      </div>
      <p className={welcomeHint}>输入 / 查看命令，@ 引用文件</p>
    </div>
  )
}

/** 会话首次加载消息时的骨架占位（几个灰色条形，不用文字提示）。 */
export function ChatSkeleton() {
  return (
    <div className={skeletonStream} aria-busy="true" data-testid="chat-skeleton">
      <div className={skeletonBar} style={{ width: '40%', height: 16 }} />
      <div className={skeletonBar} style={{ width: '68%' }} />
      <div className={skeletonBar} style={{ width: '55%' }} />
      <div className={skeletonBar} style={{ width: '72%', height: 44, borderRadius: 10 }} />
      <div className={skeletonBar} style={{ width: '45%' }} />
      <div className={skeletonBar} style={{ width: '60%' }} />
    </div>
  )
}

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
      emptyState={<ChatWelcome />}
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
      topPanel={<SetupBanner />}
      supportsVision
    />
  )
}
