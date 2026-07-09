import { css } from '@linaria/core'
import { useEffect, useState } from 'react'

/** 已加密保存徽章：apiKey 输入框旁的小提示，表示 key 已落盘。 */
const apiKeySavedBadge = css`
  font-size: 0.8em;
  color: var(--success, #2a9d8f);
  white-space: nowrap;
`

/** PasswordInput 外层 flex 容器。 */
const pwdField = css`
  display: flex;
  align-items: center;
  gap: 6px;
`

/**
 * API Key 输入。
 *
 * 不回显已加密的密文（enc: 前缀）：否则用户改完 key、保存、刷新后会看到 enc: 串
 * （而非自己输入的 key），误以为「没保存」。已加密时输入框留空，旁边提示「已加密」；
 * 用户重新输入即覆盖。未改动时 draft 仍保留原 enc: 值，保存不会误清空。
 */
function ApiKeyInput({
  stored,
  onCommit,
}: {
  stored: string | undefined
  onCommit: (value: string) => void
}) {
  const [text, setText] = useState('')
  // 外部 stored 变化（加载、保存后刷新、导入）时同步显示：密文→留空，明文→原样。
  useEffect(() => {
    setText((stored ?? '').startsWith('enc:') ? '' : (stored ?? ''))
  }, [stored])
  const isEnc = (stored ?? '').startsWith('enc:')
  return (
    <span className={pwdField}>
      <input
        type="password"
        value={text}
        placeholder={isEnc ? '已加密保存（重新输入以修改）' : 'API Key'}
        onChange={(e) => {
          setText(e.target.value)
          onCommit(e.target.value)
        }}
        data-testid="provider-apikey"
      />
      {isEnc && (
        <span className={apiKeySavedBadge} data-testid="provider-apikey-saved">
          ✓ 已加密
        </span>
      )}
    </span>
  )
}

export { ApiKeyInput }
