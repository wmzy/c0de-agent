// 聊天页横幅族共享样式：Chat.tsx（权限确认超时横幅）与 ChatSession.tsx
// （会话信息/LLM 明细/孤儿归属/中断恢复/暂停等 11 处横幅）曾逐字重复
// 「中断横幅」样式，收敛于此（与 recycleStyles.ts 同款 _shared 约定）。
import { css } from '@linaria/core'

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
