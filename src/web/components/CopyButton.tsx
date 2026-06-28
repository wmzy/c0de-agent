import { css } from '@linaria/core'
import { useState } from 'react'

const btn = css`
  font-size: 12px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  &:hover {
    color: var(--text);
  }
`

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const onClick = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <button type="button" className={btn} onClick={onClick} data-testid="copy-button">
      {copied ? '已复制' : label}
    </button>
  )
}