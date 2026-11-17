import { css } from '@linaria/core'
import { Button } from 'haze-ui'
import { ellipsisCss } from '@/styles/shared.js'

/**
 * 读取失败整行占位（原因 + 重试）：AgentSelector / ModelSelector /
 * ProviderCatalogDialog 曾各持一份逐字相同的 danger 色 css 与 role=alert 的
 * JSX（outline 重试钮），漂移只是时间问题，收敛于此。
 *
 * 与 settings/ListErrorBox、views/_shared/LoadError 的分工：那两处是**面板级**
 * 失败框（带边框、标题/明细分层），本组件是替换原控件的**紧凑占位**——
 * 「拉不到 ≠ 没有」的最小表达。文案前缀（「xx 读取失败：」）各调用点口径不同，
 * 由调用点拼好传入，不在此拼接。
 */

/** 行内变体（AgentSelector / ModelSelector）：替换 footer 里整行控件的窄占位。 */
const inlineNotice = css`
  ${ellipsisCss}
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  font-size: 12px;
  color: var(--haze-color-danger, #b3261e);
`

/** 堆叠变体（ProviderCatalogDialog）：列表面板内的整段失败，标题与重试钮上下排。 */
const stackedNotice = css`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
  font-size: 12px;
  color: var(--haze-color-danger, #b3261e);
`

/** 次级行内变体（CodeReference）：嵌入消息正文流的展开区，失败不抢 danger 红；
 * 且失败原因（路径写错/文件已删/服务端读不动）可能较长，不允许 nowrap 截断——
 * 「为什么失败」正是这里唯一有价值的信息。 */
const secondaryNotice = css`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
`

type LoadErrorNoticeProps = {
  /** 已拼好前缀的完整文案（如「AI 服务列表读取失败：…」）。 */
  message: string
  /** 重试入口；缺省不渲染按钮。 */
  onRetry?: () => void
  /** 堆叠变体（列表容器内整段失败）；默认行内。 */
  stacked?: boolean
  /** 行内变体的色调：danger（默认，控件占位的警示红）或 secondary（嵌入正文流
   * 的次级提示）；只影响行内变体，堆叠变体始终 danger。 */
  tone?: 'danger' | 'secondary'
  /** 占位 testid（调用点既有断言依赖）。 */
  testId: string
}

function LoadErrorNotice({
  message,
  onRetry,
  stacked = false,
  tone = 'danger',
  testId,
}: LoadErrorNoticeProps) {
  const retry = onRetry ? (
    <Button variant="outline" onClick={onRetry}>
      重试
    </Button>
  ) : null
  if (stacked) {
    return (
      <div className={stackedNotice} role="alert" data-testid={testId}>
        <div>{message}</div>
        {retry}
      </div>
    )
  }
  return (
    <span
      className={tone === 'secondary' ? secondaryNotice : inlineNotice}
      role="alert"
      data-testid={testId}
    >
      {message}
      {retry}
    </span>
  )
}

export { LoadErrorNotice }
