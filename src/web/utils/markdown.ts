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

/** href/src 允许的 scheme 白名单。无 scheme（相对路径、锚点、查询串）一律放行；
 *  其余（javascript:/vbscript:/data: 等）一律降级——白名单而非黑名单，
 *  新出现的可执行 scheme 默认被拒。 */
const SAFE_URL_SCHEMES = new Set([
  'http',
  'https',
  'mailto',
  'tel',
  // 产品内部 URL scheme（read 工具 / resolver 解析，见 src/tools/resolver.ts）
  'agent',
  'artifact',
  'history',
  'issue',
  'local',
  'mcp',
  'memory',
  'omp',
  'pr',
  'skill',
])

/** 数值实体 → 字符；非法码点返回空串（判定用途，不抛错）。 */
function fromCodePointOrEmpty(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** 常见命名实体（scheme 混淆相关；&colon; 在属性里会被浏览器解码为 `:`）。 */
const NAMED_ENTITIES: Record<string, string> = {
  colon: ':',
  tab: '\t',
  newline: '\n',
  sol: '/',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** 解码 HTML 实体：href/src 落 DOM 时浏览器会先解码属性值——
 *  `&#106;avascript:` / `java&#115;cript:` / `javascript&colon;` 与 `javascript:`
 *  等价。判定前必须解码，否则白名单可被实体编码整体绕过。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_, hex: string) =>
      fromCodePointOrEmpty(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d{1,7});?/g, (_, dec: string) => fromCodePointOrEmpty(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole)
}

/** URL 是否可安全写入 href/src：无 scheme 放行，有 scheme 必须命中白名单。 */
export function isSafeUrl(url: string): boolean {
  // 浏览器解析 scheme 时忽略 ASCII 控制字符与空白（java\tscript: 同样执行）。
  const probe = decodeEntities(url)
    .replace(/[\p{Cc}\s]+/gu, '')
    .toLowerCase()
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(probe)?.[1]
  return scheme === undefined || SAFE_URL_SCHEMES.has(scheme)
}

/** 未受信内容的统一转义配置：原始 HTML 一律转义为文本。
 *  marked 默认 renderer 对 html token 是原样输出（html({text}) => text）——
 *  模型输出、文件内容（md 预览）、工具结果里的 `<img onerror>`/`<script>`
 *  经 dangerouslySetInnerHTML 直接执行。两个 Marked 实例共用同一配置，
 *  避免只加固其中一个入口。 */
const untrustedHtmlRenderer = {
  html(token: { text: string }): string {
    return escapeHtml(token.text)
  },
}

/** 渲染前的公共 token 净化（危险 URL 降级）。两个实例都必须挂。 */
function sanitizeToken(token: Token): void {
  if (token.type !== 'link' && token.type !== 'image') return
  // marked 默认 renderer 的 link/image 只对 href 做 encodeURI（cleanUrl 自 v8
  // 起已无 scheme 过滤），改写为 text 即不产生锚点、只留可读标签。
  const href = (token as { href?: unknown }).href
  if (typeof href === 'string' && !isSafeUrl(href)) {
    token.type = 'text'
  }
}

marked.use({
  renderer: untrustedHtmlRenderer,
  walkTokens: sanitizeToken,
} as unknown as MarkedExtension)

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
    sanitizeToken(token)
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
    ...untrustedHtmlRenderer,
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

/** 有界渲染缓存上限（与 highlight.ts 的 hlCache 同口径）。 */
const MARKDOWN_CACHE_MAX = 200

const markdownCache = new Map<string, string>()

/**
 * 有界缓存的异步 Markdown 渲染。
 *
 * Markdown 组件此前持有一份模块级无界 Map——流式渲染期间 AssistantTextBlock
 * 的每个 text_delta 中间版本都以完整文本为 key 写入且永不驱逐，长会话下
 * 数千条完整 HTML 常驻内存只增不减。容量满时按 Map 插入序驱逐最旧条目
 * （与 highlight.ts 的 hlCache 同策略）。
 */
export async function renderMarkdownCached(content: string): Promise<string> {
  const hit = markdownCache.get(content)
  if (hit !== undefined) return hit
  const html = await renderMarkdown(content)
  if (markdownCache.size >= MARKDOWN_CACHE_MAX) {
    const oldest = markdownCache.keys().next().value
    if (oldest !== undefined) markdownCache.delete(oldest)
  }
  markdownCache.set(content, html)
  return html
}

/** 当前缓存条目数（测试与诊断用）。 */
export function markdownCacheSize(): number {
  return markdownCache.size
}
