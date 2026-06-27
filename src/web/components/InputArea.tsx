import { css } from '@linaria/core'
import { useRef, useState } from 'react'
import { SlashCommandMenu } from './SlashCommandMenu.js'

const wrap = css`
  position: relative;
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--border);
  background: var(--bg);
`

const textarea = css`
  flex: 1;
  resize: none;
  min-height: 44px;
  max-height: 200px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text);
  font: inherit;
`

export function InputArea({
  onSend,
  disabled,
  steerMode,
}: {
  onSend: (text: string) => void
  disabled?: boolean
  steerMode?: boolean
}) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const autoResize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  const send = () => {
    const v = value.trim()
    if (!v || disabled) return
    onSend(v)
    setValue('')
    if (ref.current) ref.current.style.height = 'auto'
  }

  const isSlash = value.startsWith('/') && !value.includes(' ')
  return (
    <div className={wrap}>
      {isSlash && (
        <SlashCommandMenu
          query={value}
          onPick={(c) => {
            setValue(`${c} `)
            ref.current?.focus()
          }}
        />
      )}
      <textarea
        ref={ref}
        className={textarea}
        value={value}
        placeholder={steerMode ? '注入 steering 消息…' : '输入消息，/ 查看命令'}
        onChange={(e) => {
          setValue(e.target.value)
          autoResize()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
        disabled={disabled}
        data-testid="input"
      />
      <button onClick={send} disabled={disabled || !value.trim()} type="button" data-testid="send">
        {steerMode ? '注入' : '发送'}
      </button>
    </div>
  )
}
