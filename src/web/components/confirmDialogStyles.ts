// 「确认类弹窗」家族（TrustRequiredDialog / SegmentBreakDialog /
// DangerConfirmDialog / CommitReviewDialog）的共享样式：正文说明、底部按钮行、
// 基础/主操作/危险操作按钮。此前各弹窗各持一份拷贝，DangerConfirmDialog 的
// 按钮内边距已漂移到 4px（其余为 6px 12px）——统一按 6px 12px 收敛。
import { css } from '@linaria/core'

/** 弹窗正文说明文字。 */
export const confirmBodyText = css`
  color: var(--haze-color-text-secondary);
  font-size: 13px;
  line-height: 1.5;
`

/** 底部按钮行。 */
export const confirmActions = css`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
`

/** 基础按钮（取消 / 次级动作）。 */
export const confirmBtn = css`
  padding: 6px 12px;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg-subtle);
  color: var(--haze-color-text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;

  &:hover {
    background: var(--haze-color-bg);
  }
`

/** 主操作按钮：主色实底，前景取面板背景色（浅色主题即白字）。 */
export const confirmPrimaryBtn = css`
  ${confirmBtn};
  border-color: var(--haze-color-primary, var(--haze-color-border));
  background: var(--haze-color-primary, var(--haze-color-bg-subtle));
  color: var(--haze-color-bg, #fff);
`

/*
 * 危险确认按钮：danger 实底 + on-solid 前景。--haze-color-danger 同样是按
 * 「当文字色用」调的，当实底时白字在两个主题都不过线（实测 dark 3.76 /
 * light 4.82，13px 文字需 4.5）——dark 下这是全应用唯一的「不可恢复」确认
 * 入口，却最难读。改用 --c0de-danger-on-solid：light 沿用白字（4.82 达标），
 * dark 压到足够深的近黑（见 global.ts）。悬停保持 danger 实底（覆盖基础按钮
 * 的换底）：前景是按实底调的 on-solid token，换成近白底两个主题的字都不可读。
 */
export const confirmDangerBtn = css`
  ${confirmBtn};
  border-color: var(--haze-color-danger);
  background: var(--haze-color-danger);
  color: var(--c0de-danger-on-solid, #fff);

  &:hover {
    background: var(--haze-color-danger);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`
