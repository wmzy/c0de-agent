// 读失败三段式（标题 + 原因 + 重试）的共享样式与组件：FileBrowser / FilePreview /
// KanbanView / ChatView / Settings / RootRedirect / ArchivePanel / TodoPanel
// 曾各持一份逐字副本（容器样式 + role=alert 的标题/原因 span + 重试按钮 JSX），
// 收敛于此（与 bannerStyles.ts / recycleStyles.ts 同款 _shared 约定）。
// 重试按钮复用横幅族的 secondaryButton。
import { css } from '@linaria/core'
import type { ReactNode } from 'react'
import { secondaryButton } from '@/views/_shared/bannerStyles.js'

const errorStateBase = `
  display: flex;
  flex-direction: column;
`

/** 左对齐变体：面板/侧栏内的局部读失败（文件树、文件预览、设置页）。 */
export const errorState = css`
  ${errorStateBase}
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
`

/** 居中变体：整页/整块读失败（看板、聊天历史、根重定向）。 */
export const errorStateCenter = css`
  ${errorStateBase}
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px 16px;
  text-align: center;
`

/** 失败语义标题（danger）。 */
export const errorTitle = css`
  color: var(--haze-color-danger);
  font-size: 13px;
  font-weight: 600;
`

const errorTitleCenter = css`
  color: var(--haze-color-danger);
  font-size: 14px;
  font-weight: 600;
`

/** 失败原因（次级色）。后端 message 可能是长路径/长句子，窄容器下必须能断行
 *  而不是撑出横向滚动。 */
export const errorDetail = css`
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  overflow-wrap: anywhere;
`

const errorDetailCenter = css`
  max-width: 460px;
  color: var(--haze-color-text-secondary);
  font-size: 13px;
  overflow-wrap: anywhere;
`

/** 居中变体的前置图标（根重定向的 ⚠️）。 */
const errorIcon = css`
  font-size: 32px;
`

export type LoadErrorProps = {
  /** 失败语义标题（「哪坏了」）。 */
  title?: ReactNode
  /** 失败原因：后端 message 或兜底文案（「为什么」）。 */
  detail?: ReactNode
  /** 传入即渲染重试按钮（secondaryButton 样式，「怎么办」）。 */
  onRetry?: () => void
  /** 重试按钮文案，默认「重试」。 */
  retryLabel?: string
  /** 重试按钮 testid。 */
  retryTestId?: string
  /** 容器 testid。 */
  testId?: string
  /** 居中变体（整页/整块失败）；缺省左对齐（面板内）。 */
  center?: boolean
  /** role=alert：读屏在失败发生时立刻播报，而不是等用户主动浏览到这块区域。
   *  非失败语义的静态占位（二进制说明、PDF 回退、根重定向引导）应关闭。 */
  alert?: boolean
  /** 前置图标（根重定向的 ⚠️）。 */
  icon?: ReactNode
  /** 追加动作（「在新标签页打开原始文件」等链接），渲染在重试按钮之后。 */
  children?: ReactNode
  /** 定位补充类（height:100% / margin-block:auto / flex:1 等，随宿主容器而定）。 */
  className?: string
}

/**
 * 读失败三段式：标题（danger）+ 原因（次级色，可断行）+ 重试（次级按钮），
 * 可选前置图标与追加动作。结构与各调用点此前的手写副本一致：容器 role=alert
 * 挂 testid，标题/原因各占一个 span（textContent 断言与读屏分段播报都依赖它）。
 */
export function LoadError({
  title,
  detail,
  onRetry,
  retryLabel = '重试',
  retryTestId,
  testId,
  center = false,
  alert = true,
  icon,
  children,
  className,
}: LoadErrorProps) {
  return (
    <div
      className={[center ? errorStateCenter : errorState, className].filter(Boolean).join(' ')}
      role={alert ? 'alert' : undefined}
      data-testid={testId}
    >
      {icon ? <span className={errorIcon}>{icon}</span> : null}
      {title ? <span className={center ? errorTitleCenter : errorTitle}>{title}</span> : null}
      {detail ? <span className={center ? errorDetailCenter : errorDetail}>{detail}</span> : null}
      {onRetry ? (
        <button
          type="button"
          className={secondaryButton}
          onClick={onRetry}
          data-testid={retryTestId}
        >
          {retryLabel}
        </button>
      ) : null}
      {children}
    </div>
  )
}
