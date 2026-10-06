import { css } from '@linaria/core'
import { Button } from 'haze-ui'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  TouchEvent as ReactTouchEvent,
  WheelEvent as ReactWheelEvent,
} from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StreamingIndicator } from '@/components/StreamingIndicator.js'
import { StickyUserMessage } from '@/components/session/StickyUserMessage.js'
import { TimelineChat } from '@/components/session/TimelineChat.js'
import {
  isEmptyMessage,
  type TimelineRow,
  userMessageText,
} from '@/components/session/utils/timeline.js'
import { Composer, type SendPayload } from '@/composer/Composer.js'
import type { ImagePart, Prompt } from '@/composer/types.js'
import type { AgentListItem } from '@/services/agent.js'
import {
  broadcastModeChange,
  type PermissionMode,
  permissionAPI,
  subscribeModeChange,
} from '@/services/permission.js'
import { MOBILE } from '@/styles/breakpoints.js'
import { formatTokenCount } from '@/utils/format.js'
import { TableView } from '@/views/TableView.js'

export type { SendPayload }

type ChatProps = {
  /** 统一时间线（消息 + LLM 调用 + 段标记），替代原 messages。 */
  timeline: TimelineRow[]
  isStreaming: boolean
  usage: { input: number; output: number } | null
  error?: string | null
  pendingPermission: { toolCallId: string; tool: string; input: unknown } | null
  /** 返回 false/Promise<false> 表示消息没送出去，输入框据此还原草稿。 */
  onSend: (payload: SendPayload) => boolean | undefined | Promise<boolean | undefined>
  /** 导航后把失败的消息灌回输入框（草稿页用于承接首条失败的消息）。 */
  restoreDraft?: { prompt: Prompt; images: ImagePart[] } | null
  onAbort: () => void
  /** 确认/拒绝权限请求；alwaysAllow=true 时同时把该工具加入会话白名单。 */
  onConfirm: (toolCallId: string, approved: boolean, alwaysAllow?: boolean) => void
  /** 运行出错后重试最后一条 user 消息（P2-1：与中断恢复对等的入口）。 */
  onRetry?: () => void
  /** 重发（重试/恢复）在途：按钮禁用，避免在 await 窗口内重复提交。 */
  retryPending?: boolean
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
  /** 当前会话 id（P1-5：权限模式按会话隔离）。 */
  sessionId?: string
  /** 可用 agent 列表（@ mention 渲染与校验）。 */
  agents?: AgentListItem[]
  /** 时间线为空时渲染在消息流中央的空状态（欢迎区/示例卡片），由 ChatView 注入。 */
  emptyState?: ReactNode
  /**
   * 终端面板开关（聊天页提供）。此前终端只有一个键盘入口 Ctrl+`——
   * 鼠标/触屏用户看不到任何入口，也就无从发现有终端这回事；
   * 提供时在顶栏渲染一个可与键盘快捷键对等的按钮。
   */
  terminalToggle?: { open: boolean; onToggle: () => void }
  /** P2-9：权限确认超时（保持 pending，前端重开弹窗；不再重发消息）。 */
  permissionTimeout?: {
    toolCallId: string
    tool: string
    input: unknown
    timeoutAction: 'pause' | 'deny'
  } | null
  /** 重新打开确认弹窗（P2-9）：不重发消息，工具只执行一次。 */
  onReopenPermission?: () => void
  /** 超时后拒绝该工具（run 继续）。 */
  onDenyTimedOutPermission?: () => void
  /** 工作流执行进度（/workflow run）：非空时以横幅展示当前阶段。 */
  workflowProgress?: { message: string; detail?: unknown } | null
}

/* 顶栏合并行：视图切换 + 运行状态 + 流控按钮 + 原始 JSON 单行排布，
 * 替代原先 toolbar/viewBar 两层横条，为消息流腾出垂直空间。 */
/**
 * 聊天列根容器：占满 .haze-Workbench__editor 并建立纵向 flex 上下文。
 *
 * 此前 Chat 返回 Fragment，顶栏/消息流/权限条/输入框直接平铺在 Workbench 的
 * <main> 里，而该 <main> 是 haze Workbench 提供的 display:block 容器——
 * 块级布局下 stream 的 flex:1 完全失效（block 子项不吃剩余空间，只按内容高度
 * 堆叠）。实测 1440×900：消息流仅 393px，而最后一行输入框 bottom=634，
 * <main> 底边 896 —— 底部 234px 死区；内容一多 <main> 开始滚动，滚动时
 * 顶栏被推出视口（top=-355），输入框与「发送」按钮一并滚出屏幕
 * （scrollTop=400 时 view-bar top=-355 已不可见），而消息流本身又是独立滚动
 * 容器，用户既无法把输入框滚回来，也无法用滚轮把消息读完。
 *
 * 建立 flex 列后：消息流 flex:1 吃掉全部剩余高度（393 → 627px），
 * 顶栏与输入区恒在视口内，输入区增长只压缩消息流。
 * min-height:0 是 flex 子项不撑破容器的必要条件（否则内容高度会顶开父级）。
 */
const column = css`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
`

const topBar = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg-subtle);
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
  color: var(--haze-color-text-secondary);
`

/* 流控按钮（暂停/恢复/中止）：ghost 化融入 secondary 底色横条；中止用 error 色警示 */
const ctlBtn = css`
  border: none;
  background: transparent;
  color: var(--haze-color-text-secondary);
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 12px;
  /* 覆盖全局按钮 44px 最小尺寸：保持顶栏单行紧凑，触屏热区仍达 32px */
  min-height: 32px;
  min-width: auto;

  &:hover:not(:disabled) {
    color: var(--haze-color-text);
    background: color-mix(in srgb, var(--haze-color-text) 8%, transparent);
  }

  /* 在途禁用态（重发等待 /messages 往返等）：必须有可辨识的视觉差异，
     否则按钮看起来仍可点，用户会反复点击并以为应用卡住 */
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* 面板开关态（终端）：与「恢复」等一次性动作按钮区分——它是常驻开关 */
  &[aria-pressed='true'] {
    color: var(--haze-color-primary);
    background: color-mix(in srgb, var(--haze-color-primary) 12%, transparent);
  }
`

const ctlDanger = css`
  color: var(--haze-color-danger);
  &:hover:not(:disabled) {
    color: var(--haze-color-danger);
    background: color-mix(in srgb, var(--haze-color-danger) 10%, transparent);
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
  background: var(--haze-color-bg);

  & > button {
    border: none;
    background: transparent;
    color: var(--haze-color-text-secondary);
    /* WCAG 2.5.8 触达目标下限 24px（12px 字 ≈ lh15 + 上下 padding 各 5） */
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;

    &:hover {
      color: var(--haze-color-text);
    }

    &[aria-pressed='true'] {
      background: var(--haze-color-bg-subtle);
      color: var(--haze-color-primary);
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
  color: var(--haze-color-text-secondary);
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  border-radius: 4px;
  cursor: pointer;
  &:hover {
    color: var(--haze-color-primary);
  }
  &[aria-pressed='true'] {
    color: var(--haze-color-primary);
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

/** 距底多少 px 内仍视为贴底：容忍小数像素与虚拟化测量误差，
 *  避免「明明在底部却被判成上滚」而停止跟随。 */
const BOTTOM_THRESHOLD = 32

/** 触摸位移死区（px）：小于它视为抖动，不解除跟随。 */
const TOUCH_SCROLL_SLOP = 6

/** 「回到底部」：用户上滚后不再自动跟随（见下方滚动 effect），需要一个显式入口
 *  回到最新内容。sticky 定位在滚动容器底缘——正常位置是内容末尾，上滚时吸在底部。 */
const jumpBtn = css`
  position: sticky;
  bottom: 0;
  align-self: flex-end;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  margin-bottom: 8px;
  padding: 5px 12px;
  border: 1px solid var(--haze-color-border);
  border-radius: 999px;
  background: var(--haze-color-bg);
  box-shadow: var(--haze-shadow-md);
  color: var(--haze-color-text);
  font-size: 12px;
  cursor: pointer;

  &:hover {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-primary);
  }
`

/* P1-6：权限确认超时横幅（与 ChatSession 的中断横幅同款式） */
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

/* 工作流进度横幅：窄条展示当前阶段，脉冲圆点表进行中。 */
const wfProgressBanner = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 16px;
  border-bottom: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg);
  font-size: 12px;
  color: var(--haze-color-text-secondary);
`

const wfProgressDot = css`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--haze-color-primary);
  flex-shrink: 0;
  animation: wfProgressPulse 1.4s ease-in-out infinite;
  @keyframes wfProgressPulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.25;
    }
  }
`

const wfProgressText = css`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

/* 底栏合并行：模型/工具选择 + 自动授权开关单行排布，替代原 footerBar/modeBar 两层。 */
const footerBar = css`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 4px 12px;
  border-top: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg-subtle);
  font-size: 12px;
`

/** auto 开启态的底栏：仅顶部 2px 警示细线提示状态（须在 footerBar 之后定义以按源序覆盖）。
 * 不再整条染橙——授权模式是持续状态而非错误，高饱和底色会长期压制消息流视觉。 */
const footerBarAuto = css`
  border-top: 2px solid color-mix(in srgb, var(--haze-color-warning) 55%, transparent);
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
    /* 窄屏：授权开关与警示 pill 独占整行（flex-basis 强制换行，与 footerLeft 不再共享行宽），
     * pill 允许截断不撑破容器 */
    flex-wrap: wrap;
    flex-basis: 100%;
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

/** 关闭态中性说明：次级文本色，无警示语义。
 *
 * 窄屏转 sr-only 视觉隐藏：文案「工具执行前逐个确认（全局默认）」在 390px 宽下
 * 独占一整行，把底栏从 2 行撑到 3 行——实测 844px 视口下底栏高达 149px（占 18%），
 * 消息流只剩 347px，欢迎区四张示例卡被压到滚三次才能读完，聊天区反而成了配角。
 * 隐藏后底栏 149 → 113px，消息流 347 → 383px（+10%）。
 *
 * 不直接 display:none：这句是「未开启自动授权」的语义说明，触屏没有 hover
 * title 提示，删掉后用户无法分辨当前是逐个确认还是已放行。sr-only 保留在无障碍树中，
 * 读屏用户仍能听到；视觉信息与相邻的「自动授权」开关同义，属可安全折叠的冗余文案。 */
const modeHint = css`
  color: var(--haze-color-text-secondary);
  ${MOBILE} {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
`

/** 开启态警示 pill：描边淡底（--warning 前景 + 10% 底 + 45% 边框），短文案降噪，
 * 完整风险说明移入 title 悬停提示——状态可辨识但不长期抢占视觉权重。 */
const modeWarn = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--haze-color-warning) 45%, transparent);
  background: color-mix(in srgb, var(--haze-color-warning) 10%, transparent);
  color: var(--haze-color-warning);
  font-weight: 600;
  /* 窄屏换行后允许文本截断，不横向撑破底栏 */
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

/** 会话级「始终允许」白名单 chips 行（可逐项移除）。 */
const allowChips = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
`

const allowChip = css`
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg);
  color: var(--haze-color-text-secondary);
  font-size: 11px;
  white-space: nowrap;
`

const chipRemove = css`
  border: none;
  background: transparent;
  color: var(--haze-color-text-secondary);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 0 2px;
  min-height: auto;
  min-width: auto;
  &:hover {
    color: var(--haze-color-danger);
  }
`

export function Chat({
  timeline,
  isStreaming,
  usage,
  error,
  pendingPermission,
  permissionTimeout,
  onReopenPermission,
  onDenyTimedOutPermission,
  workflowProgress,
  onSend,
  restoreDraft,
  onAbort,
  onConfirm,
  onRetry,
  retryPending,
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
  sessionId,
  agents = [],
  emptyState,
  terminalToggle,
}: ChatProps) {
  const streamRef = useRef<HTMLDivElement>(null)
  // 是否跟随最新内容：只在「用户主动上滚」时停止，回到底部/主动发送/切换会话时恢复。
  // 判据必须是用户输入事件（滚轮/触摸/键盘/滚动条拖拽）：内容增减会改变可滚动高度，
  // 浏览器随即钳制 scrollTop，用「距底距离」或「scrollTop 变小」判定会把钳制误当成
  // 上滚，从而在流式输出中途永久停止跟随（实测 gap 一路涨到 1533px 不再回到底部）。
  const followingRef = useRef(true)
  const [following, setFollowing] = useState(true)
  const touchYRef = useRef<number | null>(null)

  const setFollowingState = useCallback((next: boolean) => {
    followingRef.current = next
    setFollowing((prev) => (prev === next ? prev : next))
  }, [])

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const el = streamRef.current
      if (!el) return
      setFollowingState(true)
      el.scrollTo({ top: el.scrollHeight, behavior })
    },
    [setFollowingState],
  )

  // 滚动事件只负责「重新跟上」（滚到底部即恢复跟随），不负责「解除」。
  const handleStreamScroll = useCallback(() => {
    const el = streamRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD) {
      setFollowingState(true)
    }
  }, [setFollowingState])

  const stopFollowing = useCallback(() => setFollowingState(false), [setFollowingState])
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
  // 切换会话/视图：内容整体替换，滚动位置不能沿用（否则停在上一个会话的半截）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 会话/视图切换是重定位的触发条件，不参与计算
  useEffect(() => {
    scrollToBottom('auto')
  }, [sessionId, viewMode, scrollToBottom])
  // 跟随内容增长。依赖 timeline 引用而非 length：流式增量（text_delta / tool_call）
  // 就地追加到最后一条消息，行数不变——只看 length 会让长回复一个字都不跟随，
  // 而新行落地时的无条件滚动又把上滚阅读的用户强行拽到底部。
  // biome-ignore lint/correctness/useExhaustiveDependencies: timeline 引用变化即内容增长（流式增量不改行数）
  useEffect(() => {
    if (viewMode === 'table') return
    if (!followingRef.current) return
    scrollToBottom('auto')
  }, [timeline, viewMode, scrollToBottom])

  /** 用户输入事件：只有这些才解除跟随（滚轮上滚 / 触摸下滑 / 翻页键 / 拖滚动条）。 */
  const handleStreamWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) stopFollowing()
  }
  const handleStreamTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    touchYRef.current = e.touches[0]?.clientY ?? null
  }
  const handleStreamTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    const start = touchYRef.current
    const y = e.touches[0]?.clientY
    if (start === null || y === undefined) return
    // 手指下滑（clientY 增大）= 内容向上翻 → 用户在看上文
    if (y > start + TOUCH_SCROLL_SLOP) stopFollowing()
  }
  const handleStreamKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home') stopFollowing()
  }
  const handleStreamMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    const el = streamRef.current
    if (!el) return
    // clientWidth 不含滚动条宽度：落点在其右侧即拖拽滚动条
    const rect = el.getBoundingClientRect()
    if (e.clientX >= rect.left + el.clientWidth) stopFollowing()
  }

  // steering 由 Composer 直接驱动：流式态下「追加指令」按钮/Enter 注入运行中消息。
  // P1-5：权限模式按会话隔离（sessionId），跨标签页通过 BroadcastChannel 同步。
  // P2：同一控件在两个页面上作用域不同——会话页 = 会话级覆盖（持久化），
  // 草稿页（sessionId 缺省）= 全局运行时模式。标签与提示必须显式标注作用域。
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default')
  const [alwaysAllow, setAlwaysAllow] = useState<string[]>([])
  useEffect(() => {
    permissionAPI
      .getMode(sessionId)
      .then((res) => {
        setPermissionMode(res.mode)
        if (Array.isArray(res.alwaysAllow)) setAlwaysAllow(res.alwaysAllow)
      })
      .catch(() => {})
    const unsubscribe = subscribeModeChange(sessionId ?? null, setPermissionMode)
    return unsubscribe
  }, [sessionId])
  const togglePermissionMode = () => {
    const next: PermissionMode = permissionMode === 'auto' ? 'default' : 'auto'
    setPermissionMode(next)
    permissionAPI
      .setMode(next, sessionId)
      .then(() => broadcastModeChange({ sessionId: sessionId ?? null, mode: next }))
      .catch(() => setPermissionMode(permissionMode))
  }
  const handleSend = (payload: SendPayload) => {
    // 用户主动发送：无条件回到最新内容（此刻他就是想看到自己刚发出的消息）。
    scrollToBottom('smooth')
    return onSend(payload)
  }
  const removeAlwaysAllow = (tool: string) => {
    if (!sessionId) return
    permissionAPI
      .removeAlwaysAllow(tool, sessionId)
      .then((res) => setAlwaysAllow(res.alwaysAllow))
      .catch(() => {})
  }

  return (
    <div className={column}>
      <div className={topBar} data-testid="view-bar">
        <section className={viewSwitch} aria-label="视图模式">
          <Button
            aria-pressed={viewMode === 'chat'}
            variant="outline"
            onClick={() => setViewMode('chat')}
            data-testid="view-chat"
          >
            聊天
          </Button>
          <Button
            aria-pressed={viewMode === 'table'}
            variant="outline"
            onClick={() => setViewMode('table')}
            data-testid="view-table"
          >
            表格
          </Button>
        </section>
        <div className={topSpacer} />
        {/* topStatus 单行截断仅是排布：错误全文经 title 悬停可达（usage 态无需） */}
        {error || usage ? (
          <>
            <span
              className={topStatus}
              style={error ? { color: 'var(--haze-color-danger)' } : undefined}
              title={error ?? undefined}
            >
              {error
                ? error
                : usage
                  ? `${formatTokenCount(usage.input)} → ${formatTokenCount(usage.output)} tokens`
                  : ''}
            </span>
            {error && !isStreaming && onRetry ? (
              <button
                type="button"
                className={ctlBtn}
                onClick={onRetry}
                disabled={retryPending}
                data-testid="retry"
                title="重发最后一条消息；失败前已执行的工具可能重复执行"
              >
                重试
              </button>
            ) : null}
          </>
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
        {terminalToggle ? (
          <button
            type="button"
            className={ctlBtn}
            aria-pressed={terminalToggle.open}
            onClick={terminalToggle.onToggle}
            data-testid="toggle-terminal"
            title="终端面板（Ctrl+`）"
          >
            终端
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
      {permissionTimeout ? (
        <div className={interruptBanner} data-testid="permission-timeout-banner">
          <span>
            工具「{permissionTimeout.tool}
            」等待确认超时。重新询问将重新打开确认弹窗，不会重复执行已完成的工具；
            在弹窗中勾选「本会话始终允许」可避免该工具反复请求确认。
            若宽限期满仍未处理，该工具将被自动拒绝，
            {permissionTimeout.timeoutAction === 'pause'
              ? '对话随即暂停，等你点击「恢复」继续。'
              : '对话继续执行。'}
          </span>
          {onReopenPermission ? (
            <Button
              onClick={onReopenPermission}
              data-testid="permission-reopen"
              title="重新打开该工具的确认弹窗；本回合已执行的工具不会重复执行"
              variant="outline"
            >
              重新询问
            </Button>
          ) : null}
          {onDenyTimedOutPermission ? (
            <Button onClick={onDenyTimedOutPermission} title="拒绝该工具并继续" variant="outline">
              拒绝并继续
            </Button>
          ) : null}
        </div>
      ) : null}
      {workflowProgress ? (
        <div className={wfProgressBanner} data-testid="workflow-progress-banner">
          <span className={wfProgressDot} aria-hidden="true" />
          <span className={wfProgressText} title="工作流执行进度">
            工作流进行中：{workflowProgress.message}
          </span>
        </div>
      ) : null}
      {topPanel}
      {viewMode === 'table' ? (
        <TableView rows={timeline} />
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: 消息流滚动容器需捕获滚轮/触摸/键盘以判断用户是否上滚阅读，语义角色由内部时间线提供
        <div
          className={stream}
          data-testid="stream"
          ref={streamRef}
          onScroll={handleStreamScroll}
          onWheel={handleStreamWheel}
          onTouchStart={handleStreamTouchStart}
          onTouchMove={handleStreamTouchMove}
          onKeyDown={handleStreamKeyDown}
          onMouseDown={handleStreamMouseDown}
        >
          {viewMode === 'chat' && (
            <StickyUserMessage containerRef={streamRef} messages={stickyUserMessages} />
          )}
          {timeline.length === 0 && emptyState}
          <TimelineChat rows={timeline} showAllJson={viewMode === 'json'} />
          {isStreaming && <StreamingIndicator />}
          {!following ? (
            <button
              type="button"
              className={jumpBtn}
              onClick={() => scrollToBottom('smooth')}
              data-testid="jump-to-bottom"
            >
              ↓ 回到底部
            </button>
          ) : null}
        </div>
      )}
      {bottomPanel}
      <div
        className={permissionMode === 'auto' ? `${footerBar} ${footerBarAuto}` : footerBar}
        data-testid="permission-mode-bar"
      >
        {modelBar && <div className={footerLeft}>{modelBar}</div>}
        <div className={footerRight}>
          {alwaysAllow.length > 0 && (
            <div className={allowChips} data-testid="always-allow-chips">
              {alwaysAllow.map((tool) => (
                <span key={tool} className={allowChip}>
                  始终允许 {tool}
                  <button
                    type="button"
                    className={chipRemove}
                    onClick={() => removeAlwaysAllow(tool)}
                    aria-label={`移除 ${tool} 的始终允许`}
                    title="移出本会话白名单"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {/* 开关 label 即状态指示：auto 态标签升级为警示 pill（点击可关闭），
              不再重复渲染「自动授权」label + 相邻警示条；checkbox 始终同一节点，
              模式翻转不重建（测试与焦点都依赖节点稳定）。 */}
          <label
            className={permissionMode === 'auto' ? `${modeToggle} ${modeWarn}` : modeToggle}
            data-testid={permissionMode === 'auto' ? 'permission-mode-warning' : undefined}
            title={
              permissionMode === 'auto'
                ? sessionId
                  ? '本会话自动授权已开启：所有工具（含 bash）免确认执行（会话级覆盖，重启后仍生效）'
                  : '全局自动授权已开启：所有会话的所有工具（含 bash）免确认执行（写入全局配置，重启后仍生效）'
                : undefined
            }
          >
            <input
              type="checkbox"
              checked={permissionMode === 'auto'}
              onChange={togglePermissionMode}
              data-testid="permission-mode-toggle"
            />
            {permissionMode === 'auto'
              ? `⚠ 自动授权已开启${sessionId ? '（本会话）' : '（全局，已保存）'}`
              : `自动授权${sessionId ? '（本会话）' : '（全局）'}`}
          </label>
          {permissionMode !== 'auto' && (
            <span
              className={modeHint}
              data-testid="permission-mode-hint"
              title={
                sessionId
                  ? '本会话工具执行前逐个确认；「始终允许」白名单除外（重启后仍生效）'
                  : '全局默认授权模式：所有会话的工具执行前逐个确认（写入全局配置，重启后仍生效）'
              }
            >
              工具执行前逐个确认{sessionId ? '（本会话）' : '（全局默认）'}
            </span>
          )}
          {toolToggle}
        </div>
      </div>
      <Composer
        projectId={projectId}
        agents={agents}
        onSend={handleSend}
        restoreDraft={restoreDraft}
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
        permissionAllowAlways={!!sessionId}
        onPermissionConfirm={(alwaysAllow) =>
          pendingPermission && onConfirm(pendingPermission.toolCallId, true, alwaysAllow)
        }
        onPermissionCancel={() =>
          pendingPermission && onConfirm(pendingPermission.toolCallId, false)
        }
      />
    </div>
  )
}
