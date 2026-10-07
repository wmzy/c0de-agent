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

/** 复制按钮：剪贴板成功后以 toast 反馈（按钮体积小，原地翻字易被忽略）。
 * 失败（无剪贴板 API / 权限被拒）同样出声：此前两条失败路径都静默，用户
 * 点完毫无反馈，以为按钮坏了——非安全上下文（局域网 http 访问）和拒绝
 * 授权的浏览器都会走到这里。 */
export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const onClick = () => {
    if (!navigator.clipboard) {
      toast.danger('复制失败：浏览器不支持剪贴板')
      return
    }
    navigator.clipboard.writeText(text).then(
      () => toast.success('已复制'),
      () => toast.danger('复制失败：请允许剪贴板访问'),
    )
  }
  return (
    <button type="button" className={btn} onClick={onClick} data-testid="copy-button">
      {label}
    </button>
  )
}
