import { css } from '@linaria/core'
import { useEffect, useState } from 'react'
import { highlightCode } from '../utils/highlight.js'

const wrap = css`
  position: relative;
  border-radius: 6px;
  overflow: hidden;
  margin: 8px 0;
  background: var(--code-bg);
`

const header = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
`

const copyBtn = css`
  min-height: auto;
  min-width: auto;
  padding: 2px 8px;
  font-size: 12px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 4px;
  &:hover {
    color: var(--text);
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }
`

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState('')
  useEffect(() => {
    void highlightCode(code, lang ?? 'text').then(setHtml)
  }, [code, lang])
  return (
    <div className={wrap}>
      <div className={header}>
        <span>{lang ?? 'text'}</span>
        <button
          onClick={() => navigator.clipboard?.writeText(code)}
          type="button"
          className={copyBtn}
        >
          复制
        </button>
      </div>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki-generated safe HTML */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
