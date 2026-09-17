// 聊天状态机：AgentEvent → ChatState 的纯归约 + 跨标签页 run 状态频道。
// 从 useChat 拆出——纯函数可独立单测（useChat.test 的 reduceChatEvent 描述块），
// hook 只保留编排（SSE 消费、权限/信任/段确认的交互流）。
import type { AgentError, AgentEvent } from '@shared/types/agent.js'
import type { Message, MessageContent } from '@shared/types/message.js'
import { generateId } from '@/hooks/id.js'

export type SubagentInfo = {
  childId: string
  agentType: string
  description: string
  status: 'running' | 'completed' | 'failed'
}

export type ChatState = {
  messages: Message[]
  isStreaming: boolean
  usage: { input: number; output: number } | null
  error: string | null
  pendingPermission: { toolCallId: string; tool: string; input: unknown } | null
  /** P2-9：权限确认超时（保持 pending，前端重开弹窗；不再重发消息）。 */
  permissionTimeout: {
    toolCallId: string
    tool: string
    input: unknown
    timeoutAction: 'pause' | 'deny'
  } | null
  /** 本轮派发的子 agent 进度（spec: multi-agent-design §4.5）。 */
  subagents: SubagentInfo[]
  /** 后端检测到模型/工具变更需用户确认开新段时设置；携带活跃段信息与待重发内容。 */
  pendingSegmentBreak: PendingSegmentBreak | null
  /** P0-2：未信任项目的风险配置被 409 拦截，等待用户信任确认（或取消）。 */
  pendingTrust: PendingTrust | null
  /** SSE 流中断（服务重启等）：true 时显示恢复提示。 */
  interrupted: boolean
  /** P1：后台附着——本组件实例未发起 SSE 流，但检测到会话有活跃 run
   *  （其他标签页启动 / 挂起期间切换页面后回来）。true 时显示运行态横幅。 */
  attachedRun: boolean
  /** 自动压缩发生后的提示（可关闭）。上下文被改写，用户应可知晓。 */
  compactionNotice: string | null
  /** 服务端暂停 run（权限确认超时兜底拒绝 / 成本预算超支后按配置暂停；
   *  经 status_change(paused)/permission_expired 事件同步）。true 时显示恢复入口。 */
  runPaused: boolean
  /** 暂停原因（status_change 的 pauseReason；权限超时路径为本地合成文案）。 */
  runPauseReason: string | null
  /** 工作流执行进度（/workflow run 的 progress 事件）：横幅展示当前阶段文案。 */
  workflowProgress: { message: string; detail?: unknown } | null
}

export type PendingSegmentBreak = {
  activeSegment: { provider: string; model: string; tools: string[] }
  text: string
  opts: ChatOpts
}

/** P0-2：项目信任确认待办——后端 409 TRUST_REQUIRED 拦截后设置；
 *  用户显式信任后按原内容重发。 */
export type PendingTrust = {
  projectId: string
  projectName: string
  items: Array<{ kind: string; detail: string }>
  text: string
  opts: ChatOpts
}

export type ChatOpts = {
  provider?: string
  model?: string
  tools?: string[]
  agent?: string
  agents?: string[]
  images?: Array<{ mediaType: string; data: string }>
  files?: string[]
  /** 用户确认开新段后重发时携带，跳过后端 409 预检。 */
  confirmSegmentBreak?: boolean
}

export type ChatActions = {
  /** 发送消息；返回 false = 本轮未正常完成（供调用方做首条失败清理）。 */
  sendMessage: (content: string, opts?: ChatOpts) => Promise<boolean>
  abort: () => void
  /** 追加指令：注入运行中的 run 并乐观追加 steering 消息到时间线（P0 持久化）。 */
  steer: (message: string) => void
  /** 确认/拒绝权限请求：乐观关闭弹窗并通知后端。
   *  alwaysAllowTool 非空时先把该工具加入会话白名单。 */
  confirm: (toolCallId: string, approved: boolean, alwaysAllowTool?: string) => void
  /** 用户确认开新段：withCompaction 时先压缩会话再重发。 */
  confirmBreak: (withCompaction: boolean) => Promise<void>
  /** 用户取消开新段：清除待发状态并移除乐观追加的 user 消息。 */
  cancelBreak: () => void
  /** P0-2：信任项目后按原内容重发。 */
  confirmTrust: () => Promise<void>
  /** P0-2：取消信任——清除待发并移除乐观追加的 user 消息。 */
  cancelTrust: () => void
  /** 重试中断的对话：不追加 user 消息（已在 DB 中），直接发起 SSE 流。 */
  retry: (content: string, opts?: ChatOpts) => Promise<boolean>
  /** 权限确认超时后重新打开确认弹窗（不重发消息，工具只执行一次，P2-9）。 */
  reopenPermission: () => void
  /** 超时后拒绝该工具（显式终止 pending，run 继续）。 */
  denyTimedOutPermission: () => void
  /** 清除中断状态。 */
  clearInterrupted: () => void
  /** 清除服务端暂停态标记（点击「恢复」时乐观清除，status_change 事件随后复核）。 */
  clearRunPaused: () => void
  /** 清除压缩提示横幅。 */
  clearCompactionNotice: () => void
  /** P1：附着后台 run——查询状态与挂起权限，重挂弹窗并轮询直到 run 结束。 */
  attach: () => Promise<void>
  reset: () => void
}

export const INITIAL: ChatState = {
  messages: [],
  isStreaming: false,
  usage: null,
  error: null,
  pendingPermission: null,
  permissionTimeout: null,
  subagents: [],
  pendingSegmentBreak: null,
  pendingTrust: null,
  interrupted: false,
  attachedRun: false,
  compactionNotice: null,
  runPaused: false,
  runPauseReason: null,
  workflowProgress: null,
}

/** 把 AgentEvent 归约到消息状态。纯函数，可单测。 */
export function reduceChatEvent(state: ChatState, event: AgentEvent): ChatState {
  switch (event._tag) {
    case 'text_delta': {
      const messages = [...state.messages]
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant') {
        const content = [...last.content]
        const lastPart = content[content.length - 1]
        if (lastPart && lastPart._tag === 'text') {
          content[content.length - 1] = { _tag: 'text', text: lastPart.text + event.text }
        } else {
          content.push({ _tag: 'text', text: event.text })
        }
        messages[messages.length - 1] = { ...last, content }
      } else {
        messages.push({
          id: generateId(),
          sessionId: '',
          role: 'assistant',
          content: [{ _tag: 'text', text: event.text }],
          tokenCount: 0,
          createdAt: Date.now(),
        })
      }
      return { ...state, messages }
    }
    case 'thinking': {
      const messages = [...state.messages]
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant') {
        const content = [...last.content]
        const lastPart = content[content.length - 1]
        if (lastPart && lastPart._tag === 'thinking') {
          content[content.length - 1] = { _tag: 'thinking', text: lastPart.text + event.text }
        } else {
          content.push({ _tag: 'thinking', text: event.text })
        }
        messages[messages.length - 1] = { ...last, content }
      } else {
        messages.push({
          id: generateId(),
          sessionId: '',
          role: 'assistant',
          content: [{ _tag: 'thinking', text: event.text }],
          tokenCount: 0,
          createdAt: Date.now(),
        })
      }
      return { ...state, messages }
    }
    case 'tool_call_start': {
      const messages = [...state.messages]
      const last = messages[messages.length - 1]
      const part: MessageContent = {
        _tag: 'tool_call',
        id: event.id,
        tool: event.tool,
        input: event.input,
      }
      if (last && last.role === 'assistant') {
        messages[messages.length - 1] = { ...last, content: [...last.content, part] }
      } else {
        messages.push({
          id: generateId(),
          sessionId: '',
          role: 'assistant',
          content: [part],
          tokenCount: 0,
          createdAt: Date.now(),
        })
      }
      return { ...state, messages }
    }
    case 'tool_call_end': {
      const messages = state.messages.map((m) => {
        if (m.role !== 'assistant') return m
        const hasCall = m.content.some((p) => p._tag === 'tool_call' && p.id === event.id)
        if (!hasCall) return m
        return {
          ...m,
          content: [
            ...m.content,
            {
              _tag: 'tool_result',
              id: event.id,
              tool: '',
              output: event.result,
            } as MessageContent,
          ],
        }
      })
      return { ...state, messages }
    }
    case 'usage':
      return { ...state, usage: { input: event.input, output: event.output } }
    case 'llm_detail':
      // 纯通知事件：调用详情由 useChat 在 onEvent 中 invalidate query 刷新，
      // 状态本身不变。
      return state
    case 'subagent_start': {
      const subagents = [
        ...state.subagents.filter((s) => s.childId !== event.childId),
        {
          childId: event.childId,
          agentType: event.agentType,
          description: event.description,
          status: 'running' as const,
        },
      ]
      return { ...state, subagents }
    }
    case 'subagent_progress':
      // 进度更新（工具名/状态）暂不改变状态，避免频繁重渲
      return state
    case 'progress':
      // 工作流进度：横幅展示当前阶段（长工作流此前无任何执行期反馈）
      return { ...state, workflowProgress: { message: event.message, detail: event.detail } }
    case 'subagent_end': {
      const subagents = state.subagents.map((s) =>
        s.childId === event.childId
          ? { ...s, status: (event.success ? 'completed' : 'failed') as 'completed' | 'failed' }
          : s,
      )
      return { ...state, subagents }
    }
    case 'permission_required':
      return {
        ...state,
        pendingPermission: { toolCallId: event.toolCallId, tool: event.tool, input: event.input },
      }
    case 'heartbeat':
      // 服务端 30s 心跳（防 90s 静默看门狗误杀长工具/权限等待）；不产生任何 UI 变化。
      return state
    case 'permission_timeout':
      // P2-9：超时仅提示（store 保持 pending 等待显式确认/拒绝）。
      // 保留 input 供「重新询问」重开弹窗——不重发消息，工具只执行一次。
      return {
        ...state,
        pendingPermission: null,
        permissionTimeout: {
          toolCallId: event.toolCallId,
          tool: event.tool,
          input: event.input,
          timeoutAction: event.timeoutAction,
        },
      }
    case 'permission_expired':
      // P0 双层超时兜底：pending 已被后端自动拒绝——弹窗与「重新询问」
      // 按钮全部失效，必须清空。工具被拒的 deny 结果会以 tool 卡片出现在时间线。
      // timeoutAction='pause' 时后端已暂停 run：置 runPaused，展示恢复入口。
      return {
        ...state,
        pendingPermission: null,
        permissionTimeout: null,
        runPaused: event.timeoutAction === 'pause',
        runPauseReason:
          event.timeoutAction === 'pause'
            ? '权限确认超时：工具已被自动拒绝，对话已暂停。恢复后可直接要求 agent 重试该工具。'
            : null,
      }
    case 'status_change':
      // 服务端 run 状态同步：权限超时兜底暂停、成本预算超支暂停、或用户在其他
      // 标签页暂停——本标签页据此显示「恢复」按钮。running → 清除暂停态。
      // P3：暂停原因取服务端 pauseReason（预算超支等），无则保留 null。
      return {
        ...state,
        runPaused: event.status._tag === 'paused',
        runPauseReason: event.status._tag === 'paused' ? (event.status.pauseReason ?? null) : null,
      }
    case 'error':
      return { ...state, error: errorToMessage(event.error), workflowProgress: null }
    case 'compaction_done':
      return {
        ...state,
        compactionNotice: `已自动压缩上下文：${event.compactedCount} 条历史被摘要，保留最近 ${event.keptCount} 条。可在归档面板查看原始内容。`,
      }
    case 'done':
      return {
        ...state,
        isStreaming: false,
        pendingPermission: null,
        attachedRun: false,
        runPaused: false,
        runPauseReason: null,
        workflowProgress: null,
      }
    default:
      return state
  }
}

function errorToMessage(err: AgentError): string {
  switch (err._tag) {
    case 'aborted':
      return '已中止'
    case 'max_turns':
      return `达到最大轮数 ${err.maxTurns}`
    case 'unexpected':
      return err.message
    case 'provider':
      return err.message
    case 'tool':
      return `工具 ${err.toolName} 错误: ${err.message}`
  }
}

/** 跨标签页 run 状态频道（P1：同会话多标签页启动/结束广播，触发他页附着/刷新）。 */
export const RUN_CHANNEL = 'c0de-run-state'
/** 本标签页唯一 id：BroadcastChannel 会把消息投递给同页的其他频道对象
 *  （仅排除投递对象本身），订阅侧据此忽略本页广播，避免自发自收。 */
export const TAB_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)

export type RunStateMessage = { from: string; sessionId: string; active: boolean }

export function broadcastRunState(msg: Omit<RunStateMessage, 'from'>): void {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return
  try {
    const ch = new BroadcastChannel(RUN_CHANNEL)
    ch.postMessage({ ...msg, from: TAB_ID })
    ch.close()
  } catch {
    // BroadcastChannel 不可用：忽略（无跨标签页同步）
  }
}
