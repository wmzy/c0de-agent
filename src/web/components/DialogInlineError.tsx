// 弹窗内的失败原因反馈，多站点共享：模态操作失败时原因必须画在弹窗内部
//（role=alert 播报；Esc / 点背景 / ✕ 不会把它连同面板一起丢掉）。此前各弹窗
// 各持一份——有的裸红字、有的带框、有的是内联 style 且无 testid——统一按
// TrustRequiredDialog errorText 的带框样式收敛（边框 + bg-subtle + 12px +
// overflow-wrap:anywhere，长错误串（URL/堆栈片段）不会撑破面板）。
import { css } from '@linaria/core'
import type { ReactNode } from 'react'

const box = css`
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--haze-color-danger, #e5484d);
  border-radius: 6px;
  background: var(--haze-color-bg-subtle);
  color: var(--haze-color-danger, #e5484d);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
`

/** 弹窗内错误框：带框 + role=alert。testId 供测试定位（调用点必须传，裸 div 无法稳定断言）。 */
export function DialogInlineError({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className={box} role="alert" data-testid={testId}>
      {children}
    </div>
  )
}
