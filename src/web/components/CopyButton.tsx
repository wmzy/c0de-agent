import { css } from '@linaria/core'
import { toast } from 'haze-ui'

const btn = css`
  font-size: 12px;
  color: var(--haze-color-text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  &:hover {
    color: var(--haze-color-text);
  }
`

/** 复制按钮：剪贴板成功后以 toast 反馈（按钮体积小，原地翻字易被忽略）。 */
export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const onClick = () => {
    navigator.clipboard?.writeText(text).then(() => {
      toast.success('已复制')
    })
  }
  return (
    <button type="button" className={btn} onClick={onClick} data-testid="copy-button">
      {label}
    </button>
  )
}
