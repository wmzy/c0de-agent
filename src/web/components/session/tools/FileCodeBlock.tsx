import { css } from '@linaria/core'
import { CodeBlock } from '@/components/CodeBlock.js'
import { CollapsiblePre } from '@/components/session/tools/CollapsiblePre.js'
import { extToLang } from '@/components/session/utils/lang.js'

const wrap = css`
  margin: 4px 0;
`

/** 未知扩展名的纯文本代码块：不折行（代码按行读，长行横向滚动优于折断）。 */
const pre = css`
  margin: 0;
  padding: 8px;
  background: var(--haze-color-bg-muted);
  border-radius: 6px;
  font-size: 13px;
`

/**
 * 文件代码块：已知扩展名用 shiki 高亮，否则纯 pre。
 * 折叠档位取 300/600（比工具输出的 200/400 宽：文件内容通常整屏读）。
 */
export function FileCodeBlock({ path, content }: { path: string; content: string }) {
  const lang = extToLang(path)
  return (
    <div className={wrap}>
      <CollapsiblePre collapsedHeight={300} expandedHeight={600}>
        {lang === 'text' ? (
          <pre className={pre}>{content}</pre>
        ) : (
          <CodeBlock code={content} lang={lang} />
        )}
      </CollapsiblePre>
    </div>
  )
}
