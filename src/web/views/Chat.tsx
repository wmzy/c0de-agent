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
  /**
   * 首条消息在途（草稿页正在建会话，尚未建立 run/SSE）。
   *
   * 与 isStreaming 必须分开：这段窗口里没有 run 可中止、也无法 steering，此前
   * 借 isStreaming 表示会让输入区整块翻成运行态——「追加指令」可用而 onSteer
   * 是空实现（steer 无条件清空输入框，用户接着敲的字静默消失），主按钮翻成红色
   * 「终止」而 onAbort 是空函数（按了零反应）。真跑起来时按钮都得指向真实动作，
   * 否则宁可让它们不可用。
   */
  creating?: boolean
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
  /** 注入 steering 消息（spec §3.9），运行中可用。
   *  返回 Promise<boolean>：false 表示这条指令没被受理（后端 {steered:false} 或
   *  请求失败），输入区据此保留草稿并在错误行给出原因。 */
  onSteer?: (message: string) => boolean | undefined | Promise<boolean | undefined>
  /** agent 是否处于暂停态（控制 pause/resume 按钮切换）。 */
  paused?: boolean
  /**
   * 暂停/恢复/中止等运行控制失败的原因。
   *
   * 与 error（发送失败）分开：控制端点失败不代表消息失败，且此前完全无反馈
   * ——按钮照常翻转，用户以为对话已停而它仍在消耗 token。
   */
  controlError?: string | null
  /**
   * 「终止」没送达的原因：POST /api/chat/abort 失败，或后端回 {aborted:false}。
   *
   * 与 controlError（暂停/恢复）分开：终止失败后 isStreaming 已是 false，
   * 用户唯一的补救是再发一次终止——横幅自带「重新终止」，不让这条提示无出口。
   */
  abortError?: string | null
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

/**
 * 发送失败提示条：独占一行、可换行、role="alert"（读屏播报）。
 *
 * 此前错误挤在顶栏 status 槽里，单行 nowrap + ellipsis：1280 宽就已截断，
 * 1024 宽实测 clientWidth 473 / scrollWidth 529（尾部 10% 被「…」吃掉），
 * 而截断掉的部分恰恰是补救指令——「请检查拼写，或前往「设置 → Provider」
 * 添加该服务」。悬停 title 是唯一全文入口，触屏无 title、无 hover，
 * 读屏也读不到（span 无 role）。窄屏下顶栏还挤着视图切换/终端/原始 JSON，
 * 整条提示被挤到只剩省略号，等于「发送失败」这件事的处置方式对多数用户不可见。
 * 独占一行后错误全文始终完整可读，且 alert 角色让屏幕阅读器立即念出。
 */
const errorBanner = css`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid
    color-mix(in srgb, var(--haze-color-danger) 45%, transparent);
  background: color-mix(in srgb, var(--haze-color-danger) 10%, transparent);
  font-size: 12px;
  line-height: 1.5;
  color: var(--haze-color-danger);
`

/** 提示文案：不限行数（wrap），容器再窄也只增高不丢字。 */
const errorBannerText = css`
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
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
  /* flex-basis 320px ≈ agent + Provider + Model 的舒适宽度。footerBar 本身
     是 flex-wrap:wrap：底栏放不下「模型控件 + 授权区」时，footerRight 整体
     换到下一行，而不是两者在同一行里互相挤压——挤压会把 Provider/Model
     压到内容宽度以下，标签互相重叠（实测重叠 3px，读作「ProvideModel」），
     Provider 下拉只剩 38px 无法辨认。
     宽度够时（实测宽栏 1138px）仍是单行，行为与此前一致。 */
  flex: 1 1 320px;
  min-width: 0;
  /* 换行不按视口宽度判定，而是**始终**允许：底栏的可用宽度由会话列决定，
   * 与视口宽度无关——1440px 视口下打开文件预览，会话列被压到 636px。
   * 控件自身也不允许超出容器，避免被 main 的 overflow:hidden 裁掉。 */
  flex-wrap: wrap;
  & select,
  & input {
    max-width: 100%;
  }
`

const footerRight = css`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  /* 授权区保持内容宽度、不与模型控件争抢同一行：放不下时由 footerBar 的
   * flex-wrap 把整块换到下一行（footerLeft 已是 flex:1 1 320px，会先占满
   * 自己那一行）。此前 footerLeft 是 flex:1（basis 0）而本块 margin-left:auto
   * 且 flex-shrink:0——实测窄栏下本块硬占 406px、把 footerLeft 挤到 198px，
   * Provider/Model 被压到标签叠字。 */
  flex-shrink: 0;
  min-width: 0;
  flex-wrap: wrap;
  ${MOBILE} {
    /* 窄屏：授权开关与警示 pill 独占整行（flex-basis 强制换行，与 footerLeft 不再共享行宽），
     * pill 允许截断不撑破容器 */
    flex-basis: 100%;
    margin-left: 0;
    max-width: 100%;
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

/** 权限状态读取/写入失败行：把「读不到」与「确实是默认模式」区分开。 */
const modeError = css`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--haze-color-danger, #e5484d);
`

const modeErrorRetry = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: var(--haze-color-bg);
  color: inherit;
  cursor: pointer;
  font-size: 11px;
  padding: 0 6px;
  min-height: auto;
  min-width: auto;
`

export function Chat({
  timeline,
  isStreaming,
  creating = false,
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
  controlError = null,
  abortError = null,
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
  /** 权限状态读取失败的原因：不为空时底栏显示的开关/白名单不可信，必须说出来。 */
  const [permissionLoadError, setPermissionLoadError] = useState<string | null>(null)
  /** 移除白名单失败的原因：此前是空 catch —— 点 × 后界面纹丝不动、零反馈。 */
  const [alwaysAllowError, setAlwaysAllowError] = useState<string | null>(null)
  /** 权限模式写入失败的原因。切换是乐观翻转 + 失败回滚，此前回滚零提示：开关
   *  自己弹回去，用户看到的是「点不动」，既不知道原因、也不知道服务端仍是哪个
   *  模式——而这正是安全相关的模式开关（以为已开自动授权的人会据此少点确认，
   * 实际服务端仍逐个确认，反之亦然）。 */
  const [permissionModeError, setPermissionModeError] = useState<string | null>(null)
  /** 切换失败时用户想切到的模式：重试要重发的是这个意图，不是再次翻转。 */
  const [permissionModeTarget, setPermissionModeTarget] = useState<PermissionMode | null>(null)
  /** 写入进行中的模式（非 null 即 pending），用于禁用重试、避免重复提交。 */
  const [permissionModeSaving, setPermissionModeSaving] = useState<PermissionMode | null>(null)
  /**
   * 会话世代号：切会话后作废在飞的那轮读写。
   *
   * Chat 与 ChatSession 都被路由复用（同 path 的两条路由共享子树，组件实例不重建），
   * 而底栏这一组状态是「**本会话**的授权结论」——此前 loadPermissionMode 只发请求、
   * 只在响应里写 state：切到会话 B 后，B 的读取返回前显示的是 A 的授权态；若 B 的
   * 读取失败则永久停在 A 的值（页面上长期挂着一句与事实相反的安全结论：以为 B 的
   * bash 免确认，实际逐个确认，或反之）。A 的迟到响应同样会覆盖掉 B 已读到的真实值。
   */
  const permissionGenRef = useRef(0)
  const loadPermissionMode = useCallback(() => {
    const gen = permissionGenRef.current
    permissionAPI
      .getMode(sessionId)
      .then((res) => {
        if (permissionGenRef.current !== gen) return
        setPermissionMode(res.mode)
        if (Array.isArray(res.alwaysAllow)) setAlwaysAllow(res.alwaysAllow)
        setPermissionLoadError(null)
      })
      .catch((e: unknown) => {
        if (permissionGenRef.current !== gen) return
        // 此前是空 catch：state 停在初始值 'default' + []，底栏于是显示未勾选的
        // 「自动授权（本会话）」并附「工具执行前逐个确认」，而服务端可能正处于
        // auto 模式（或已放行 bash 白名单）——给出的是相反的安全结论，且
        // alwaysAllow.length > 0 的 chips 行整块消失，唯一的白名单管理入口
        // 一起没了。读不到就必须说读不到。
        setPermissionLoadError(e instanceof Error ? e.message : String(e))
      })
  }, [sessionId])
  useEffect(() => {
    // 切会话先复位：旧会话的 auto 警示 / 白名单 chips / 失败文案都不能跟过来。
    // 与 ChatSession 顶部横幅族（interruptBanner / sessionMeta / orphan）以及
    // useShake / useRetryResume 的 sessionId 复位同口径。
    setPermissionMode('default')
    setAlwaysAllow([])
    setPermissionLoadError(null)
    setAlwaysAllowError(null)
    setPermissionModeError(null)
    setPermissionModeTarget(null)
    setPermissionModeSaving(null)
    loadPermissionMode()
    const unsubscribe = subscribeModeChange(sessionId ?? null, setPermissionMode)
    return () => {
      // 卸载或切会话：作废在飞的那轮读写（迟到的响应不得写进新会话）。
      permissionGenRef.current++
      unsubscribe()
    }
  }, [sessionId, loadPermissionMode])
  const applyPermissionMode = (next: PermissionMode) => {
    const gen = permissionGenRef.current
    setPermissionModeError(null)
    setPermissionModeTarget(null)
    setPermissionModeSaving(next)
    setPermissionMode(next)
    return permissionAPI
      .setMode(next, sessionId)
      .then(() => {
        if (permissionGenRef.current !== gen) return
        setPermissionModeSaving(null)
        broadcastModeChange({ sessionId: sessionId ?? null, mode: next })
      })
      .catch((e: unknown) => {
        // 回滚：此前只有 setPermissionMode(permissionMode)，开关自己弹回去。
        // 界面「按不动」而无任何说明，用户只会反复点，或以为模式已经切成功。
        // 切会话后不得回滚/报错进新会话（那是把上一条会话的模式写进别人的底栏）。
        if (permissionGenRef.current !== gen) return
        setPermissionModeSaving(null)
        setPermissionMode(permissionMode)
        setPermissionModeTarget(next)
        setPermissionModeError(e instanceof Error ? e.message : String(e))
      })
  }
  const togglePermissionMode = () => {
    void applyPermissionMode(permissionMode === 'auto' ? 'default' : 'auto')
  }
  const handleSend = (payload: SendPayload) => {
    // 用户主动发送：无条件回到最新内容（此刻他就是想看到自己刚发出的消息）。
    scrollToBottom('smooth')
    return onSend(payload)
  }
  const removeAlwaysAllow = (tool: string) => {
    if (!sessionId) return
    const gen = permissionGenRef.current
    permissionAPI
      .removeAlwaysAllow(tool, sessionId)
      .then((res) => {
        if (permissionGenRef.current !== gen) return
        setAlwaysAllow(res.alwaysAllow)
        setAlwaysAllowError(null)
      })
      .catch((e: unknown) => {
        // 空 catch 的后果：用户点 chips 上的 × 后没有任何变化，反复点、以为
        // 点不动；服务端白名单其实还在，该工具仍免确认执行。这是移除一项安全
        // 授权的唯一入口。
        if (permissionGenRef.current !== gen) return
        setAlwaysAllowError(e instanceof Error ? e.message : String(e))
      })
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
        {/* usage 态（token 计数）留在顶栏：它是常驻计量、单行短文本，截断无信息损失。
            error 态改由下方 errorBanner 独占一行承载（见 errorBanner 注释）。 */}
        {!error && usage ? (
          <span className={topStatus}>
            {`${formatTokenCount(usage.input)} → ${formatTokenCount(usage.output)} tokens`}
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
      {controlError ? (
        <div className={errorBanner} data-testid="control-error" role="alert">
          <span className={errorBannerText}>{controlError}</span>
        </div>
      ) : null}
      {abortError ? (
        <div className={errorBanner} data-testid="abort-error" role="alert">
          <span className={errorBannerText}>{abortError}</span>
          <button
            type="button"
            className={ctlBtn}
            onClick={onAbort}
            data-testid="abort-retry"
            title="再次请求后端终止这次运行"
          >
            重新终止
          </button>
        </div>
      ) : null}
      {error ? (
        <div className={errorBanner} data-testid="send-error" role="alert">
          <span className={errorBannerText}>{error}</span>
          {!isStreaming && !creating && onRetry ? (
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
        </div>
      ) : null}
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
      {/* 时间线为空时不留在表格视图：历史加载失败的错误+重试（以及空会话的欢迎区）
          此前只挂在非表格分支上，表格视图下只剩筛选条 + 0/0 + 「无匹配项」——用户
          据此认为这个会话是空的，既看不到失败原因，也没有重试入口（注入 500 后实测）。 */}
      {viewMode === 'table' && timeline.length > 0 ? (
        <TableView rows={timeline} sessionId={sessionId} />
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
          {permissionLoadError ? (
            <span className={modeError} role="alert" data-testid="permission-mode-error">
              权限状态读取失败：{permissionLoadError}
              <button
                type="button"
                className={modeErrorRetry}
                onClick={loadPermissionMode}
                data-testid="permission-mode-retry"
              >
                重试
              </button>
            </span>
          ) : null}
          {/* 写入失败：开关已回滚到服务端真实模式，但必须说明这次切换没生效并给
              重试——否则用户只看到开关弹回去，判定为「点不动」而反复点击。 */}
          {permissionModeError ? (
            <span className={modeError} role="alert" data-testid="permission-mode-set-error">
              切换权限模式失败：{permissionModeError}
              {permissionModeTarget ? (
                <button
                  type="button"
                  className={modeErrorRetry}
                  onClick={() => void applyPermissionMode(permissionModeTarget)}
                  disabled={permissionModeSaving !== null}
                  data-testid="permission-mode-set-retry"
                >
                  重试
                </button>
              ) : null}
            </span>
          ) : null}
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
          {alwaysAllowError ? (
            <span className={modeError} role="alert" data-testid="always-allow-error">
              移出白名单失败：{alwaysAllowError}
            </span>
          ) : null}
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
              disabled={permissionModeSaving !== null}
              data-testid="permission-mode-toggle"
            />
            {permissionMode === 'auto'
              ? `⚠ 自动授权已开启${sessionId ? '（本会话）' : '（全局，已保存）'}`
              : `自动授权${sessionId ? '（本会话）' : '（全局）'}`}
          </label>
          {/* 读取失败时不渲染「工具执行前逐个确认」：那是拿初始值当真实模式，
              正好给出与事实相反的安全结论（服务端可能已处于 auto）。 */}
          {permissionMode !== 'auto' && !permissionLoadError && (
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
        // 草稿按会话隔离；草稿页（尚未建会话）按项目隔离——两者都是「用户以为还留着」的输入。
        draftScope={sessionId ? `s:${sessionId}` : projectId ? `p:${projectId}` : undefined}
        onAbort={onAbort}
        onSteer={onSteer}
        isStreaming={isStreaming}
        creating={creating}
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
