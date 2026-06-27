import { Marked, type MarkedExtension } from 'marked'
import { highlightCode } from './highlight.js'

const marked = new Marked({ gfm: true, breaks: true })

/** 同步渲染 Markdown（代码块不高亮，供首屏）。 */
export function renderMarkdownSync(content: string): string {
  return marked.parse(content) as string
}

/** 异步渲染（代码块走 Shiki 高亮）。 */
export async function renderMarkdown(content: string): Promise<string> {
  const instance = new Marked({ gfm: true, breaks: true })
  instance.use({
    renderer: {
      code(codeText: string, infostring: string | undefined, _escaped: boolean) {
        const lang = infostring ?? 'text'
        return highlightCode(codeText, lang)
          .then((html) => `<div class="code-block">${html}</div>`)
          .catch(() => `<pre><code>${codeText}</code></pre>`)
      },
    },
  } as unknown as MarkedExtension)
  return (await instance.parse(content)) as string
}
