// 代码块：haze CodeBlock（语言徽标 + highlight 插件式异步高亮）+
// 项目原有的复制按钮（haze CodeBlock 无 copy 能力）。
import { css } from '@linaria/core'
import { CodeBlock as HazeCodeBlock } from 'haze-ui'
import { highlightCode } from '@/utils/highlight.js'

const wrap = css`
  position: relative;
  margin: 8px 0;
`

/** 复制按钮：右下角悬浮，避开 haze 右上角的语言徽标。 */
const copyBtn = css`
  position: absolute;
  right: 8px;
  bottom: 8px;
  min-height: auto;
  min-width: auto;
  padding: 2px 8px;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  cursor: pointer;
  &:hover {
    color: var(--haze-color-text);
    background: var(--haze-color-bg-subtle);
  }
`

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  return (
    <div className={wrap}>
      <HazeCodeBlock language={lang ?? 'text'} highlight={highlightCode}>
        {code}
      </HazeCodeBlock>
      <button
        type="button"
        className={copyBtn}
        onClick={() => navigator.clipboard?.writeText(code)}
      >
        复制
      </button>
    </div>
  )
}
