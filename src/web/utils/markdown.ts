import { Marked, type MarkedExtension, type Token } from 'marked'
import { highlightCode } from './highlight.js'

const marked = new Marked({ gfm: true, breaks: true })

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
      const lang = token.lang ?? 'text'
      if (token._highlighted) {
        return `<div class="code-block" data-lang="${lang}">${token._highlighted}</div>`
      }
      // fallback：未高亮时返回原始代码
      return `<div class="code-block" data-lang="${lang}"><pre><code>${token.text}</code></pre></div>`
    },
  },
} as unknown as MarkedExtension)

export async function renderMarkdown(content: string): Promise<string> {
  return (await configuredMarked.parse(content, { async: true })) as string
}
