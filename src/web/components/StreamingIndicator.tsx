// 流式输入指示：haze ThinkingIndicator（标签 + 跳动圆点），
// 外层保留项目原有的 status/aria 契约供屏幕阅读器播报。
import { ThinkingIndicator } from 'haze-ui'

export function StreamingIndicator() {
  return (
    <span data-testid="streaming" role="status" aria-label="正在输入">
      <ThinkingIndicator text="正在输入" />
    </span>
  )
}
