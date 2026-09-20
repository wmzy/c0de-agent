import { Marked, type MarkedExtension, type Token } from 'marked'
import { highlightCode } from '@/utils/highlight.js'

const marked = new Marked({ gfm: true, breaks: true })

/** 转义 HTML 特殊字符（& < > "），供自定义 code renderer 使用。
 *  marked 默认 renderer 会自行转义；一旦覆盖 renderer，转义责任转移到
 *  renderer——lang（围栏语言）与 fallback text 都是未受信输入，裸插值会
 *  从 data-lang 属性越界注入元素/脚本（输出经 dangerouslySetInnerHTML 落 DOM）。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 同步渲染 Markdown（代码块不高亮，供首屏）。 */
export function renderMarkdownSync(content: string): string {
  return marked.parse(content) as string
}

/**
 * 异步渲染（代码块走 Shiki 高亮）。
 *
 * 关键：marked 的 `async: true` 选项只对 `walkTokens` 生效，不会 await
 * renderer 返回的 Promise。若在 renderer.code 里直接返回高亮 Promise，
 * marked 会把 Promise 字符串化为 "[object Promise]" 拼进 HTML。
 * 因此用 walkTokens 在解析前异步高亮，把结果挂到 token 上，
 * renderer 同步读取。
 */
const configuredMarked = new Marked({ gfm: true, breaks: true })
configuredMarked.use({
  async: true,
  async walkTokens(token: Token) {
    if (token.type === 'code' && typeof token.text === 'string') {
      const lang = token.lang ?? 'text'
      try {
        ;(token as Token & { _highlighted?: string })._highlighted = await highlightCode(
          token.text,
          lang,
        )
      } catch {
        // 高亮失败留空，renderer 走 fallback
      }
    }
  },
  renderer: {
    code(token: { _highlighted?: string; text: string; lang?: string }) {
      // lang 与 fallback text 均转义：未受信输入不得裸拼进 HTML 属性/元素内容。
      // _highlighted 来自 Shiki（自身转义），保持信任。
      const lang = escapeHtml(token.lang ?? 'text')
      if (token._highlighted) {
        return `<div class="code-block" data-lang="${lang}">${token._highlighted}</div>`
      }
      // fallback：未高亮时返回转义后的原始代码
      return `<div class="code-block" data-lang="${lang}"><pre><code>${escapeHtml(token.text)}</code></pre></div>`
    },
  },
} as unknown as MarkedExtension)

export async function renderMarkdown(content: string): Promise<string> {
  return (await configuredMarked.parse(content, { async: true })) as string
}
