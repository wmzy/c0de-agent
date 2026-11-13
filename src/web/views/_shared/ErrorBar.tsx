// 列表行内的紧凑错误条（标题 + 可选原因 + 可选重试按钮）。RecycleBin 的五个
// 读失败入口（整页加载 / 搜索 / 孤儿计数 / 未归属看板 / 孤儿列表）曾各持一份
// 同构 JSX（errorBar 容器 + 「：原因」或「，请稍后重试。」拼接 + 重试按钮），
// 其中整页加载那份还漏了 role=alert——读屏不会在失败发生时主动播报——收敛于此。
// 与 errorState.tsx 的 LoadError 分工：LoadError 是面板/整页的三段式块（标题/
// 原因各占一个 span）；ErrorBar 是列表行内的单行条，样式沿用 recycleStyles 的
// errorBar（SessionList 回收站入口同款视觉），重试按钮复用 restoreBtn。
import { errorBar, restoreBtn } from '@/views/_shared/recycleStyles.js'

export type ErrorBarProps = {
  /** 失败语义标题（「哪坏了」），如「回收站加载失败」。 */
  label: string
  /** 后端 message（messageOf 提取，可为 null）；缺省时给「请稍后重试」兜底，
   *  不退化成光秃标题。 */
  message?: string | null
  /** 传入即渲染重试按钮。 */
  onRetry?: () => void
  /** 重试按钮 testid。 */
  retryTestId?: string
  /** 容器 testid。 */
  testId?: string
}

/** 失败必须可闻（role=alert）且可自救（重试）。文案结构与收敛前各处一致：
 *  `标题：原因` / `标题，请稍后重试。`（textContent 断言依赖这一拼接）。 */
export function ErrorBar({ label, message, onRetry, retryTestId, testId }: ErrorBarProps) {
  return (
    <div className={errorBar} role="alert" data-testid={testId}>
      {label}
      {message ? `：${message}` : '，请稍后重试。'}{' '}
      {onRetry ? (
        <button type="button" className={restoreBtn} onClick={onRetry} data-testid={retryTestId}>
          重试
        </button>
      ) : null}
    </div>
  )
}
