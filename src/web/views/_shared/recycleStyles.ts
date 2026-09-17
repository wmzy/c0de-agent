// 回收站面板共享样式：SessionList（回收站入口/错误提示）与 RecycleBin（面板本体）
// 共用同一视觉语言，样式定义收敛于此（painless views/_shared 同款约定）。
import { css } from '@linaria/core'

export const searchInput = css`
  margin: 8px 12px 0;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  min-height: auto;
  width: auto;
`

export const empty = css`
  padding: 16px 12px;
  color: var(--text);
  opacity: 0.6;
  font-size: 13px;
  text-align: center;
`

export const errorBar = css`
  padding: 6px 12px;
  font-size: 12px;
  color: var(--error);
  border-bottom: 1px solid var(--border);
`

export const noticeBar = css`
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
`
