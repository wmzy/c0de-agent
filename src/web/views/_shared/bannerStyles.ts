// 聊天页横幅族共享样式：Chat.tsx（权限确认超时横幅）与 ChatSession.tsx
// （会话信息/LLM 明细/孤儿归属/中断恢复/暂停等 11 处横幅）曾逐字重复
// 「中断横幅」样式，收敛于此（与 recycleStyles.ts 同款 _shared 约定）。
import { css } from '@linaria/core'

/** 横幅按钮与读失败态重试按钮共用的次级按钮基础样式：interruptBanner 的
 *  `& > button` 与 ChatView 此前手写的重试按钮样式各持一份逐字副本，收敛于此
 *  （横幅内按钮由 interruptBanner 直接覆盖，无需再挂 secondaryButton 类）。 */
const secondaryButtonBase = `
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 12px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
`

/** 独立使用的次级按钮（读失败态的重试、走廊提示条的「重新读取」等）。 */
export const secondaryButton = css`
  ${secondaryButtonBase}

  &:hover:not(:disabled) {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-primary);
  }
`

export const interruptBanner = css`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg-subtle);
  font-size: 13px;
  color: var(--haze-color-text-secondary);

  & > button {
    ${secondaryButtonBase}

    &:first-of-type {
      border-color: var(--haze-color-primary);
      color: var(--haze-color-primary);
    }
  }
`
