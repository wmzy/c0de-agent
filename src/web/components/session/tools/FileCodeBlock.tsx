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
  overflow: auto;
  font-size: 13px;
  max-height: 400px;
`

const collapsed = css`
  max-height: 300px;
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
  const showToggle = overflowing && !expanded
  return (
    <div className={wrap}>
      {lang === 'text' ? (
        <div ref={ref} className={showToggle ? collapsed : ''}>
          <pre className={pre}>{content}</pre>
        </div>
      ) : (
        <div ref={ref} className={showToggle ? collapsed : ''}>
          <CodeBlock code={content} lang={lang} />
        </div>
      )}
      {overflowing && (
        <button type="button" className={btn} onClick={toggle}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  )
}