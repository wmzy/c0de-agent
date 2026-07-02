import { css } from '@linaria/core'
import { CodeBlock } from '../../CodeBlock.js'
import { useOverflow } from '../hooks/useOverflow.js'
import { extToLang } from '../utils/lang.js'

const wrap = css`
  display: flex;
  flex-direction: column;
  margin: 4px 0;
`

const pre = css`
  margin: 0;
  padding: 8px;
  background: var(--code-bg);
  border-radius: 6px;
  font-size: 13px;
`

/** 内容滚动容器：始终限高 + 纵向滚动，避免超长内容纵向溢出挤压后续块。 */
const scroll = css`
  overflow: auto;
  max-height: 300px;
`

const scrollExpanded = css`
  max-height: 600px;
`

const btn = css`
  align-self: flex-start;
  font-size: 12px;
  color: var(--primary);
  background: transparent;
  border: none;
  cursor: pointer;
`

/** 文件代码块：已知扩展名用 shiki 高亮，否则纯 pre。 */
export function FileCodeBlock({ path, content }: { path: string; content: string }) {
  const lang = extToLang(path)
  const { ref, overflowing, expanded, toggle } = useOverflow(300)
  return (
    <div className={wrap}>
      <div ref={ref} className={`${scroll} ${expanded ? scrollExpanded : ''}`}>
        {lang === 'text' ? (
          <pre className={pre}>{content}</pre>
        ) : (
          <CodeBlock code={content} lang={lang} />
        )}
      </div>
      {overflowing && (
        <button type="button" className={btn} onClick={toggle}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  )
}
