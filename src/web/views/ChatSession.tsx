// src/web/views/ChatSession.tsx
// 有会话 id 的聊天页：统一时间线、Shake 模式、中断恢复。
// 从 ChatView.tsx 拆出（2026-09），样式与状态只服务于本组件。

import { css } from '@linaria/core'
import { useRouter } from '@native-router/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from 'haze-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AgentSelector } from '@/components/AgentSelector.js'
import { ArchivePanel } from '@/components/ArchivePanel.js'
import { Dialog } from '@/components/Dialog.js'
import { ModelSelector } from '@/components/ModelSelector.js'
import { SegmentBreakDialog } from '@/components/SegmentBreakDialog.js'
import { SessionSummary } from '@/components/SessionSummary.js'
import { ShakeProvider } from '@/components/session/ShakeContext.js'
import { mergeSessionMessages } from '@/components/session/utils/normalizeParts.js'
import { buildTimeline } from '@/components/session/utils/timeline.js'
import { TodoPanel } from '@/components/TodoPanel.js'
import { ToolToggle } from '@/components/ToolToggle.js'
import { TrustRequiredDialog } from '@/components/TrustRequiredDialog.js'
import { clearSessionDraft } from '@/composer/draft.js'
import type { ImagePart, Prompt } from '@/composer/types.js'
import { failedSendReason } from '@/hooks/failedSendReason.js'
import { pendingFirstMessage } from '@/hooks/pendingFirstMessage.js'
import { useAgent } from '@/hooks/useAgent.js'
import { useChat } from '@/hooks/useChat.js'
import { useComposerDefaults } from '@/hooks/useComposerDefaults.js'
import { useRetryResume } from '@/hooks/useRetryResume.js'
import { useMessages } from '@/hooks/useSession.js'
import { useShake } from '@/hooks/useShake.js'
import { navigateTo } from '@/navigateTo.js'
import { agentAPI } from '@/services/agent.js'
import { providerAPI } from '@/services/provider.js'
import { sessionAPI } from '@/services/session.js'
import { Chat, type SendPayload } from '@/views/Chat.js'
import { ChatHistoryError, ChatSkeleton, ChatWelcome, SetupBanner } from '@/views/ChatView.js'

const interruptBanner = css`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg-subtle);
  font-size: 13px;
  color: var(--haze-color-text-secondary);

  & > button {
    border: 1px solid var(--haze-color-border);
    border-radius: 6px;
    padding: 3px 12px;
    cursor: pointer;
    font-size: 12px;
    background: var(--haze-color-bg);
    color: var(--haze-color-text);

    &:first-of-type {
      border-color: var(--haze-color-primary);
      color: var(--haze-color-primary);
    }
  }
`

const bannerError = css`
  color: var(--haze-color-danger);
`

const shakeBtn = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: transparent;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
  cursor: pointer;

  &:hover {
    background: var(--haze-color-bg-subtle);
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
  border: 1px solid color-mix(in srgb, var(--haze-color-warning) 50%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--haze-color-warning) 8%, transparent);
  font-size: 12px;
  color: var(--haze-color-warning);

  & > span {
    color: var(--haze-color-text-secondary);
  }

  & > button {
    border: 1px solid var(--haze-color-border);
    border-radius: 3px;
    padding: 1px 8px;
    font-size: 11px;
    cursor: pointer;
    background: var(--haze-color-bg);
    color: var(--haze-color-text);

    &:hover {
      background: var(--haze-color-bg-subtle);
    }

    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
  }
`

const shakeErrorLine = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 4px;
  font-size: 12px;
  color: var(--haze-color-danger);
`

const shakeExitBtn = css`
  border: none !important;
  background: transparent !important;
  color: var(--haze-color-text-secondary) !important;
  padding: 0 4px !important;

  &:hover {
    color: var(--haze-color-text) !important;
  }
`

const exportChoiceDesc = css`
  font-size: 13px;
  line-height: 1.6;
  color: var(--haze-color-text);
`

const exportChoiceNote = css`
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--haze-color-text-secondary);
`

const exportChoiceError = css`
  margin-top: 8px;
  padding: 6px 10px;
  border: 1px solid var(--haze-color-danger);
  border-radius: 6px;
  font-size: 12px;
  color: var(--haze-color-danger);
`

const exportChoiceBtn = css`
  padding: 4px 12px;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  font-size: 13px;
  cursor: pointer;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`

/** 分支数量检查失败时的内联重试按钮：与说明文字同行，不占据 footer。 */
const exportBranchRetry = css`
  padding: 0;
  border: none;
  background: transparent;
  color: var(--haze-color-primary);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
`

/** 主操作是「剥离快照」——默认与回车都走安全的一侧。 */
const exportChoicePrimary = css`
  padding: 4px 12px;
  border: 1px solid var(--haze-color-primary);
  border-radius: 6px;
  background: var(--haze-color-primary);
  color: var(--haze-color-on-primary, #fff);
  font-size: 13px;
  cursor: pointer;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`

export function ChatSession({
  projectId,
  sessionId,
  terminalToggle,
}: {
  projectId: string
  sessionId: string
  /** 终端面板开关（ChatView 透传）：顶栏「终端」入口。 */
  terminalToggle?: { open: boolean; onToggle: () => void }
}) {
  const chat = useChat(sessionId)
  const agent = useAgent(sessionId)
  const qc = useQueryClient()
  const router = useRouter()
  const {
    data: history,
    isLoading,
    isError: historyFailed,
    error: historyError,
    refetch: refetchHistory,
  } = useMessages(sessionId)
  const { selection, setSelection, enabledTools, setEnabledTools, agentName, setAgentName } =
    useComposerDefaults(projectId)
  // P2-3：会话归属校验——URL 与会话所属项目不一致时跳转到正确项目；
  // 会话无归属（孤儿）时提供归属到当前项目的入口。
  const { data: sessionMeta } = useQuery({
    queryKey: ['session', sessionId, 'meta'],
    queryFn: () => sessionAPI.get(sessionId),
  })
  const [orphanNotice, setOrphanNotice] = useState(false)
  // 归属失败原因。此前该 mutation 只有 onSuccess：POST /rebind 返回 500 /
  // 项目已被删 / 服务重启时，按钮从 pending 恢复可点、横幅纹丝不动、页面零文字，
  // 用户以为按钮坏了（同一动作在 RecycleBin 有 onError 文案）——孤儿会话唯一
  // 的自救入口就此静默失效（该会话的工具全部无法执行）。
  const [rebindError, setRebindError] = useState<string | null>(null)
  const rebindToCurrent = useMutation({
    mutationFn: () => sessionAPI.rebind(sessionId, projectId),
    onMutate: () => setRebindError(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions', 'tree'] })
      qc.invalidateQueries({ queryKey: ['session', sessionId, 'meta'] })
      setOrphanNotice(false)
      setRebindError(null)
    },
    onError: (e: unknown) =>
      setRebindError(
        (e as { message?: string } | null)?.message ?? (e instanceof Error ? e.message : String(e)),
      ),
  })
  useEffect(() => {
    if (!sessionMeta) return
    if (sessionMeta.projectId && sessionMeta.projectId !== projectId) {
      navigateTo(router, '/projects/:projectId/sessions/:sessionId', {
        params: { projectId: sessionMeta.projectId, sessionId },
      })
    } else if (!sessionMeta.projectId) {
      setOrphanNotice(true)
    }
  }, [sessionMeta, projectId, sessionId, router])
  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentAPI.listAgents(),
    staleTime: 60_000,
  })
  // 草稿页 pending 首条消息仅消费一次（ref 防 StrictMode 双调用）
  const consumed = useRef(false)
  // 首条发送失败时暂存载荷，供 cleanupEmptySessionOnFailure 带去草稿页还原。
  const lastFailedSend = useRef<{
    text: string
    prompt: Prompt
    images: ImagePart[]
    files: string[]
  } | null>(null)
  // chat 是每次渲染新建的 {...state, …} 快照：cleanupEmptySessionOnFailure 在
  // .then 里读 chat 的**值字段**只会拿到发送前那一帧，失败原因/门禁必须走 chat
  // 暴露的 lastFailure ref（对象身份跨渲染稳定）。
  const chatRef = useRef(chat)
  chatRef.current = chat

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
  // mergeSessionMessages 同时把「已持久化的乐观副本」丢弃：本轮消息落库后任何
  // 历史重取（窗口聚焦 refetch、shake 应用、附着结束刷新）都会把同一轮以服务端
  // id 再取回，直接拼接会让整轮对话重复渲染两份。
  const messages = useMemo(
    () => mergeSessionMessages(history ?? [], chat.messages),
    [history, chat.messages],
  )

  // LLM 调用段：llm_detail 事件会 invalidate 此 query（见 useChat），实时刷新。
  // 读失败必须说出来：此前只取 data，`segments ?? []` 让 buildTimeline 拿空段列表
  // 渲染出「只有消息、没有调用/段标记」的时间线——那是把「拉不到」说成「这次没有
  // 调用」，而且消失的正是排查「这轮到底调了什么模型/花多少钱」的唯一入口
  // （表格/原始 JSON 视图消费的是同一条 timeline）。同一条 query 在 SessionSummary
  // 里已有完整三段式处理，两处口径必须一致。
  const {
    data: segments,
    isError: llmDetailsFailed,
    error: llmDetailsError,
    isFetching: llmDetailsFetching,
    refetch: refetchLlmDetails,
  } = useQuery({
    queryKey: ['session', sessionId, 'llm-details'],
    queryFn: () => sessionAPI.llmDetails(sessionId),
    staleTime: 10_000,
  })
  const llmDetailsErrorMessage =
    (llmDetailsError as { message?: string } | null)?.message ??
    (llmDetailsError instanceof Error ? llmDetailsError.message : null)

  // 统一时间线：消息 + LLM 调用 + 段标记按时间交错融合。
  // M3：session.metadata 记录的未完成轮次区间传入，中断前的半截内容置灰展示。
  const unfinishedRange =
    sessionMeta?.metadata.unfinishedSinceEntryId && sessionMeta?.metadata.unfinishedUntilEntryId
      ? {
          sinceId: sessionMeta.metadata.unfinishedSinceEntryId,
          untilId: sessionMeta.metadata.unfinishedUntilEntryId,
        }
      : null
  const timeline = useMemo(
    () => buildTimeline(messages, segments ?? [], unfinishedRange),
    // sessionMeta 仅用于 unfinishedRange；直接依赖区间值避免整体失效。
    [messages, segments, unfinishedRange],
  )

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
    // 这条消息经由 pendingFirstMessage 从草稿页转来（没走 handleSend），
    // 失败时同样要能把「消息 + 原因」带回草稿页，这里补记一份载荷。
    lastFailedSend.current = {
      text: pending.text,
      prompt: pending.prompt ?? [],
      // ChatOpts.images 是裸 {mediaType,data}（服务端契约），ImagePart 多一个
      // type 判别字段（composer 内部形态），还原前补上。
      images: (pending.opts.images ?? []).map((img) => ({
        type: 'image' as const,
        mediaType: img.mediaType,
        data: img.data,
      })),
      files: pending.opts.files ?? [],
    }
    void chat.sendMessage(pending.text, pending.opts).then((ok) => {
      void cleanupEmptySessionOnFailure(ok, true)
    })
  }, [sessionId])

  // 启用工具白名单：null = 默认全启用（不传 tools，走后端 config）；Set = 显式选择
  const handleSend = (payload: SendPayload) => {
    // 新一轮发送：清除上轮残留的暂停态（paused 仅在运行中有意义）。
    agent.resetPaused()
    const firstMessage = messages.length === 0
    // 把 ok 回传给输入框：false 时输入框把草稿与图片还回来。用户消息只在 agent
    // loop 真正跑起来时才落库（core/agent.ts），上述错误都发生在落库之前——
    // 输入清空 + 乐观消息被撤回 = 用户刚打的字彻底消失，改好设置后回车也没得发。
    return chat
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
        if (!ok && firstMessage) lastFailedSend.current = payload
        void cleanupEmptySessionOnFailure(ok, firstMessage)
        return ok
      })
  }

  const handleConfirm = (toolCallId: string, approved: boolean, alwaysAllow?: boolean) => {
    // 把当前 pending 一并交进去：确认请求送达失败时（500/网络）弹窗要原样回来，
    // 否则 dock 已被乐观关闭、run 却在服务端等着这个决定，页面上没有任何入口。
    chat.confirm(
      toolCallId,
      approved,
      alwaysAllow ? chat.pendingPermission?.tool : undefined,
      chat.pendingPermission ?? undefined,
    )
  }

  /** 首条消息发送失败（未配 provider/网络中断且无持久化消息）→ 删除空会话回草稿页，
   *  避免每次失败尝试在会话树里留下空「New Session」堆积（P3 空会话治理）。
   *  导航会把 ChatSession 卸载、错误随之消失——失败原因必须跨组件传下去，
   *  否则用户看到的是「什么都没发生」。 */
  const cleanupEmptySessionOnFailure = async (ok: boolean, firstMessage: boolean) => {
    if (ok || !firstMessage) return
    // 读 ref 而不是 chat 快照里的字段：失败路径的 setState 还没重渲染，快照里
    // 只有发起发送那一帧的值（原来读 chatRef.current.lastFailureReason，恒为 null，
    // 用户永远只看到兜底的「消息发送失败，请重试后再次发送」）。
    const failure = chatRef.current.lastFailure.current
    // 「等待用户决策」的失败（未信任项目的风险确认 / 段边界确认）不是发送白费：
    // 弹窗就渲染在本组件里，清会话 + 导航回草稿页会把弹窗连同原因一起卸载——
    // 用户只剩一句没有任何信息量的重试提示，且每次重试都必然复现（P0）。
    if (failure.gate) return
    try {
      const msgs = await sessionAPI.messages(sessionId)
      if (msgs.length === 0) {
        // P3-9：物理删除而非软删除——空「New Session」壳进回收站会污染列表，
        // 且用户从未与之交互过，无回收价值（服务端二次校验非空即 409）。
        await sessionAPI.purgeEmpty(sessionId)
        // 会话已物理删除：还原分支落回 s:<sessionId> 的失败快照草稿再也无人
        // 读取（文本无上限、图片最多 ~512KB），随之清退，避免永久滞留 localStorage。
        clearSessionDraft(sessionId)
        qc.invalidateQueries({ queryKey: ['sessions'] })
        qc.invalidateQueries({ queryKey: ['sessions', 'tree'] })
        // 会话没了，但「消息 + 失败原因」要带去草稿页：导航会卸载本组件，
        // 输入框里的草稿和 useChat 的 error 一起消失，用户只会看到什么都没发生。
        failedSendReason.set(projectId, {
          reason: failure.reason ?? '消息发送失败，请重试后再次发送',
          payload: {
            text: lastFailedSend.current?.text ?? '',
            prompt: lastFailedSend.current?.prompt ?? [],
            images: lastFailedSend.current?.images ?? [],
            files: lastFailedSend.current?.files ?? [],
          },
        })
        navigateTo(router, '/projects/:projectId', { params: { projectId } })
      }
    } catch {
      // 清理失败不阻塞：会话树里至多多一个空会话，可手动删除
    }
  }

  // shake 内联模式：状态与交互流收敛在 useShake（ChatSession 只渲染工具栏）
  const shake = useShake(sessionId, messages, qc)

  // 归档面板开关
  const [showArchives, setShowArchives] = useState(false)

  // 会话导出：下载 JSON（元数据 + 消息 + 归档），数据可迁移（改进建议 #4）。
  // P0 明示：导出仅含本会话消息与归档，fork 分支/子会话不在其中——有分支时
  // 导出前确认告知（此前用户以为完整备份，分支关系静默丢失）。
  // P2-6：归档 fileSnapshots 含文件内容，默认剥离；仅显式确认后随迁。
  //
  // 导出必须有闭环：进行中禁用按钮（否则连点两次 = 两个 confirm + 两次导出请求），
  // 失败把原因摊开。此前 catch 整段吞掉，用户点完看不到任何变化，会认定文件已经
  // 存好就关掉页面，备份静默失败。
  //
  // 快照策略用站内弹窗而不是原生 confirm：这是隐私选择，而原生框只有
  // 「确定/取消」，且「确定」（含快照、会泄露文件内容）恰好落在回车的默认位、
  // 推荐的「取消（剥离）」反而不该被当成取消操作。两个问题叠在一起，用户
  // 肌肉记忆按回车就把文件内容打包进了要分享的导出文件。
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  /** 分支数量（null=尚未查完，还在拉）。查完才让用户做选择，避免决策后又弹第二个框。 */
  const [exportBranchCount, setExportBranchCount] = useState<number | null>(null)
  /** 分支数量查询失败的说明（null=没失败）。失败与「确实没有分支」必须分开。 */
  const [exportBranchFailed, setExportBranchFailed] = useState<string | null>(null)

  const openExportDialog = async () => {
    setExportError(null)
    setExportBranchCount(null)
    setExportBranchFailed(null)
    setExportDialogOpen(true)
    try {
      const branches = await sessionAPI.branches(sessionId)
      setExportBranchCount(branches.length)
    } catch (err) {
      // 「读不到分支数」≠「没有分支」：此前 catch(() => []) 把失败吞成 0，弹窗于是
      // 改口宣称「导出内容：本会话的全部消息与归档」，用户据此把导出件当成完整备份，
      // 而真正的派生分支内容并不在其中（迁移/分享后静默丢失）。改为显式失败态：
      // 说明无法确认影响面 + 内联重试，并放行导出——连不上时把用户永久挡在按钮外
      // 比放行更糟，但绝不再宣称内容完整。
      setExportBranchFailed(err instanceof Error ? err.message : '无法读取派生分支')
    }
  }

  const runExport = async (includeSnapshots: boolean) => {
    if (exporting) return
    setExporting(true)
    setExportError(null)
    try {
      const data = await sessionAPI.exportSession(sessionId, { includeSnapshots })
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const title = (data.session.title || 'session').replace(/[^\w一-鿿-]+/g, '_')
      a.href = url
      a.download = `${title}.c0de-session.json`
      a.click()
      URL.revokeObjectURL(url)
      setExportDialogOpen(false)
    } catch (err) {
      setExportError(
        err instanceof Error && err.message ? `导出失败：${err.message}` : '导出失败，请重试',
      )
    } finally {
      setExporting(false)
    }
  }

  const closeExportDialog = () => {
    if (exporting) return
    setExportDialogOpen(false)
    setExportError(null)
  }

  // 中断恢复/出错重试：prompt 定位与重发编排收敛在 useRetryResume
  const { handleResume, handleRetryLast, resendPending, resendError, clearResendError } =
    useRetryResume({
      sessionId,
      chat,
      qc,
      selection,
      agentName,
      onResumeStart: () => setColdStartInterrupted(false),
    })
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

  // 失败原因取服务端 message（APIError）或 Error.message，与侧栏会话树失败提示同口径。
  const historyErrorMessage =
    (historyError as { message?: string } | null)?.message ??
    (historyError instanceof Error ? historyError.message : null)

  if (isLoading && messages.length === 0) return <ChatSkeleton />
  return (
    <ShakeProvider value={shake.shakeContextValue}>
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
        workflowProgress={chat.workflowProgress}
        onReopenPermission={chat.reopenPermission}
        onDenyTimedOutPermission={chat.denyTimedOutPermission}
        onSend={handleSend}
        onAbort={chat.abort}
        onConfirm={handleConfirm}
        onRetry={() => void handleRetryLast()}
        retryPending={resendPending}
        onPause={agent.pause}
        onResume={() => {
          // 服务端暂停（权限超时兜底）：乐观清除标记，resume 端点真正恢复 run；
          // status_change(running) 事件随后复核状态。
          chat.clearRunPaused()
          agent.resume()
        }}
        onSteer={chat.steer}
        paused={agent.paused || chat.runPaused}
        controlError={agent.error}
        supportsVision={supportsVision}
        emptyState={
          // 历史拉取失败且无可展示内容：绝不能落进 ChatWelcome（那会谎称「这是新会话」，
          // 用户会以为上下文丢了）。给出失败原因 + 重试，输入框保持可用。
          historyFailed && messages.length === 0 ? (
            <ChatHistoryError
              message={historyErrorMessage ?? ''}
              onRetry={() => void refetchHistory()}
            />
          ) : (
            <ChatWelcome />
          )
        }
        terminalToggle={terminalToggle}
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
            projectId={projectId}
          />
        }
        bottomPanel={<TodoPanel sessionId={sessionId} projectId={projectId} />}
        topPanel={
          <>
            <SetupBanner projectId={projectId} />
            {llmDetailsFailed ? (
              <div className={interruptBanner} role="alert" data-testid="llm-details-error">
                <span>
                  调用明细读取失败，本时间线里的 LLM 调用与分段标记不可见（不是本次会话没有调用）：
                  {llmDetailsErrorMessage || '未知原因'}
                </span>
                <Button
                  variant="outline"
                  onClick={() => void refetchLlmDetails()}
                  disabled={llmDetailsFetching}
                  data-testid="llm-details-retry"
                >
                  重试
                </Button>
              </div>
            ) : null}
            {orphanNotice && (
              <div className={interruptBanner} data-testid="orphan-session-banner">
                {sessionMeta?.worktreePath ? (
                  <>
                    <span>
                      该会话未归属任何项目（来自 CLI）：工具将在其原目录执行（
                      {sessionMeta.worktreePath}
                      ）。归属到当前项目可将其纳入项目会话列表。
                    </span>
                    <Button
                      variant="outline"
                      onClick={() => rebindToCurrent.mutate()}
                      disabled={rebindToCurrent.isPending}
                    >
                      归属到当前项目
                    </Button>
                  </>
                ) : (
                  <>
                    <span>
                      该会话未归属任何项目（原项目已删除），无法执行工具。归属到当前项目后可继续使用。
                    </span>
                    <Button
                      variant="outline"
                      onClick={() => rebindToCurrent.mutate()}
                      disabled={rebindToCurrent.isPending}
                    >
                      归属到当前项目
                    </Button>
                  </>
                )}
                {rebindError && (
                  <span className={bannerError} role="alert" data-testid="orphan-rebind-error">
                    归属到当前项目失败：{rebindError}
                  </span>
                )}
              </div>
            )}
            {resendError && (
              <div className={interruptBanner} role="alert" data-testid="resend-error">
                <span>{resendError}</span>
                <Button variant="outline" onClick={clearResendError}>
                  知道了
                </Button>
              </div>
            )}
            {showInterruptBanner && !chat.isStreaming && (
              <div className={interruptBanner} data-testid="interrupt-banner">
                {sessionMeta?.agentType === 'workflow' ? (
                  <>
                    <span>
                      工作流执行已中断（服务可能已重启）。工作流运行会话无 user 消息可重发，
                      无法原地恢复：
                      {sessionMeta.metadata?.workflowName
                        ? `可在任意会话重新执行 /workflow run ${sessionMeta.metadata.workflowName} 发起新的运行（新会话节点）。`
                        : '可重新执行 /workflow run <name> 发起新的运行（新会话节点）。'}
                    </span>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setColdStartInterrupted(false)
                        chat.clearInterrupted()
                      }}
                    >
                      知道了
                    </Button>
                  </>
                ) : (
                  <>
                    <span>
                      连接已中断（服务可能已重启）。恢复将重发上一条消息，已执行的工具可能重复执行
                    </span>
                    <Button
                      variant="outline"
                      onClick={() => void handleResume()}
                      disabled={resendPending}
                      title="重发上一条消息继续；中断前已执行的工具（bash/git 等）可能再次执行"
                    >
                      恢复对话
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setColdStartInterrupted(false)
                        chat.clearInterrupted()
                      }}
                    >
                      忽略
                    </Button>
                  </>
                )}
              </div>
            )}
            {chat.attachedRun && (
              <div className={interruptBanner} data-testid="attached-run-banner">
                <span>
                  对话正在运行中（可能在其他标签页启动，或挂起期间切换了页面）。完成后自动刷新。
                </span>
                <Button variant="outline" onClick={() => chat.abort()} title="中止后台运行中的对话">
                  中止
                </Button>
              </div>
            )}
            {chat.runPaused && chat.isStreaming && (
              <div className={interruptBanner} data-testid="run-paused-banner">
                <span>
                  {chat.runPauseReason ??
                    '权限确认超时：工具已被自动拒绝，对话已暂停（不会在无人确认时继续执行）。点击「恢复」继续，恢复后可直接要求 agent 重试该工具。'}
                </span>
                <Button
                  variant="outline"
                  onClick={() => {
                    chat.clearRunPaused()
                    agent.resume()
                  }}
                  title="恢复 run：从暂停点继续执行"
                >
                  恢复
                </Button>
              </div>
            )}
            {chat.compactionNotice && (
              <div className={interruptBanner} data-testid="compaction-notice-banner">
                <span>{chat.compactionNotice}</span>
                <Button
                  variant="outline"
                  onClick={() => chat.clearCompactionNotice()}
                  title="关闭提示"
                >
                  知道了
                </Button>
              </div>
            )}
            {coldStartPaused && !chat.isStreaming && (
              <div className={interruptBanner} data-testid="paused-banner">
                <span>对话处于暂停状态，可继续执行</span>
                <Button
                  variant="outline"
                  onClick={() => {
                    // 活跃 run 仍注册在服务端（页面刷新场景），resume 端点可真正恢复；
                    // 服务重启导致的 paused 已由 status 端点转为 interrupted（走重发路径）。
                    setColdStartPaused(false)
                    agent.resume()
                  }}
                >
                  继续对话
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setColdStartPaused(false)
                    chat.clearInterrupted()
                  }}
                >
                  忽略
                </Button>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, padding: '4px 12px' }}>
              {shake.shakeMode ? (
                <div className={shakeToolbar} data-testid="shake-toolbar">
                  <span>⚡ Shake 模式</span>
                  <span>
                    已选 {shake.shakeSelected.size}/{shake.shakeRegions.length} · 省{' '}
                    {shake.shakeSelectedTokens}t
                  </span>
                  <Button
                    variant="outline"
                    onClick={() =>
                      shake.setShakeSelected(new Set(shake.shakeRegions.map((r) => r.id)))
                    }
                    data-testid="shake-select-all"
                  >
                    全选
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => shake.setShakeSelected(new Set())}
                    data-testid="shake-deselect-all"
                  >
                    取消全选
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => shake.shakeMutation.mutate([...shake.shakeSelected])}
                    disabled={shake.shakeSelected.size === 0}
                    data-testid="shake-submit"
                  >
                    提交 Shake
                  </Button>
                  <button
                    type="button"
                    className={shakeExitBtn}
                    onClick={shake.exitShakeMode}
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
                  onClick={() => void shake.handleShakeOpen()}
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
                onClick={() => void openExportDialog()}
                disabled={exporting}
                data-testid="export-button"
                title="导出会话（消息 + 归档）为 JSON 文件"
              >
                {exporting ? '导出中…' : '导出'}
              </button>
              <SessionSummary sessionId={sessionId} />
            </div>
            {/* 预览/提交失败必须说出来：失败时界面与点击前完全一致（预览时按钮零反应、
                提交时抖动模式照旧），用户只能判定为「功能坏了」并反复点。预览失败时
                给重试入口；提交失败时 shakeMode 仍在、被选中的区域没被裁掉，「提交
                Shake」按钮本身就是重试入口，不重复给。 */}
            {shake.shakeError ? (
              <div className={shakeErrorLine} role="alert" data-testid="shake-error">
                <span>Shake 失败：{shake.shakeError}</span>
                {shake.shakeMode ? null : (
                  <button
                    type="button"
                    className={shakeBtn}
                    onClick={() => void shake.handleShakeOpen()}
                    data-testid="shake-retry"
                  >
                    重试
                  </button>
                )}
              </div>
            ) : null}
          </>
        }
      />
      {exportDialogOpen && (
        <Dialog
          open
          onClose={closeExportDialog}
          closeDisabled={exporting}
          title="导出会话 JSON"
          testId="export-dialog"
          footer={
            <>
              <button
                type="button"
                className={exportChoiceBtn}
                onClick={closeExportDialog}
                disabled={exporting}
              >
                取消
              </button>
              <button
                type="button"
                className={exportChoiceBtn}
                data-testid="export-include-snapshots"
                onClick={() => void runExport(true)}
                disabled={exporting || (exportBranchCount === null && !exportBranchFailed)}
              >
                包含文件快照导出
              </button>
              <button
                type="button"
                className={exportChoicePrimary}
                data-testid="export-strip-snapshots"
                onClick={() => void runExport(false)}
                disabled={exporting || (exportBranchCount === null && !exportBranchFailed)}
              >
                {exporting ? '导出中…' : '剥离快照导出（推荐）'}
              </button>
            </>
          }
        >
          <div className={exportChoiceDesc}>
            归档里的「文件快照」是被压缩进上下文的<strong>文件内容</strong>。剥离后对话、
            统计、归档结构都不受影响，只是不带文件正文——分享导出文件时不会泄露这些内容。
          </div>
          <div className={exportChoiceNote} data-testid="export-branch-note">
            {exportBranchFailed ? (
              <>
                无法确认派生分支数量（{exportBranchFailed}）：导出只含本会话的消息与归档，
                分支内容不在其中。
                <button
                  type="button"
                  className={exportBranchRetry}
                  data-testid="export-branch-retry"
                  onClick={() => void openExportDialog()}
                >
                  重试检查
                </button>
              </>
            ) : exportBranchCount === null ? (
              '正在检查派生分支…'
            ) : exportBranchCount > 0 ? (
              `该会话有 ${exportBranchCount} 个派生分支：导出只含本会话的消息与归档，分支内容不在其中。`
            ) : (
              '导出内容：本会话的全部消息与归档。'
            )}
          </div>
          {exportError ? (
            <div className={exportChoiceError} role="alert" data-testid="export-dialog-error">
              {'⚠'} {exportError}
            </div>
          ) : null}
        </Dialog>
      )}
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
      {chat.pendingTrust && (
        <TrustRequiredDialog
          projectName={chat.pendingTrust.projectName}
          items={chat.pendingTrust.items}
          error={chat.trustError}
          busy={chat.trustPending}
          onConfirm={() => void chat.confirmTrust()}
          onCancel={() => chat.cancelTrust()}
        />
      )}
      {showArchives && (
        <ArchivePanel sessionId={sessionId} onClose={() => setShowArchives(false)} />
      )}
    </ShakeProvider>
  )
}
