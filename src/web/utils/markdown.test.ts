import { describe, expect, it, vi } from 'vitest'

// Mock shiki 高亮：返回可识别的 HTML，隔离测试 marked 异步集成机制本身。
// 核心回归点是 marked 的 async 处理，与 shiki 实现无关。
// 与真实 Shiki 同语义：输出内容经 HTML 转义；lang='fail' 时抛错以走 fallback 路径。
vi.mock('./highlight.js', () => ({
  highlightCode: vi.fn(async (code: string, lang: string) => {
    if (lang === 'fail') throw new Error('highlight unavailable')
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `<pre data-mock-lang="${esc(lang)}">${esc(code)}</pre>`
  }),
}))

// Mock 必须在 import 之前生效
const { renderMarkdown, renderMarkdownSync, renderMarkdownCached, markdownCacheSize } =
  await import('@/utils/markdown.js')

describe('renderMarkdown', () => {
  it('代码块被正确高亮，绝不字符串化为 [object Promise]', async () => {
    // 回归：renderer.code 返回 Promise 时若未走 walkTokens+async，
    // marked 会把 Promise stringify 成 "[object Promise]"。
    const md = '分析项目结构\n\n```bash\nfind . -type f\n```\n\n完成'
    const html = await renderMarkdown(md)
    expect(html).not.toContain('[object Promise]')
    expect(html).toContain('code-block')
    expect(html).toContain('find . -type f')
  })

  it('多个代码块全部被高亮，无 [object Promise] 残留', async () => {
    // 对应用户现场：模型写了多个 bash 代码块（find/ls/cat），
    // 修复前每个代码块渲染成一个 [object Promise]。
    const md = [
      '```bash\nfind .\n```',
      '```bash\nls -la\n```',
      '```bash\ncat package.json\n```',
    ].join('\n\n')
    const html = await renderMarkdown(md)
    const promiseCount = (html.match(/\[object Promise\]/g) || []).length
    expect(promiseCount).toBe(0)
    // 三个代码块都应出现原始内容
    expect(html).toContain('find .')
    expect(html).toContain('ls -la')
    expect(html).toContain('cat package.json')
  })

  it('普通文本与行内代码正常渲染', async () => {
    const html = await renderMarkdown('这是 **粗体** 和 `inline code`')
    expect(html).toContain('<strong>粗体</strong>')
    expect(html).toContain('<code>inline code</code>')
    expect(html).not.toContain('[object Promise]')
  })

  it('renderMarkdownSync 同步渲染不含高亮但无 [object Promise]', () => {
    const html = renderMarkdownSync('```bash\nfind .\n```')
    expect(html).not.toContain('[object Promise]')
  })

  // 回归：自定义 code renderer 对 lang 与 fallback text 做裸插值——围栏语言
  // 可构造 `x"><img src=x onerror=...>` 从 data-lang 属性越界注入元素，
  // 经 Markdown 组件的 dangerouslySetInnerHTML 执行脚本（可窃取 localStorage token）。
  // 默认 marked renderer 会转义，自定义后转义责任落到 renderer。
  it('转义代码块语言属性，阻断属性越界注入', async () => {
    const md = '```x"><img src=x onerror=alert(1)>\nbody\n```'
    const html = await renderMarkdown(md)
    expect(html).toContain('code-block')
    // 无未转义元素注入（onerror 只允许以转义文本形式出现）
    expect(html).not.toContain('<img')
    expect(html).toContain('data-lang="x&quot;&gt;&lt;img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('高亮失败 fallback 路径转义代码文本，阻断脚本注入', async () => {
    const md = '```fail\n<script>alert(1)</script>\n```'
    const html = await renderMarkdown(md)
    expect(html).toContain('code-block')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

// 回归：代码块 renderer 转义修复只覆盖了 code 分支。marked 默认 renderer 对
// 原始 HTML token 是**原样输出**（html({text}) => text），对链接/图片的 href
// 也只做 encodeURI（cleanUrl 早于 v8 就不再有 scheme 黑名单）——模型输出、
// 文件内容（FilePreview 的 md 预览）、工具结果里出现的 `<img onerror>` 或
// `[x](javascript:...)` 都会经 dangerouslySetInnerHTML 落 DOM 执行脚本
// （可窃取 localStorage 中的设备 token）。未受信内容必须转义 + scheme 白名单。
describe('未受信 HTML 与 URL 注入', () => {
  it('块级原始 HTML 转义为文本，不产生可执行元素', async () => {
    const html = await renderMarkdown(
      '<img src=x onerror="alert(1)">\n\n<div onclick="alert(2)">b</div>',
    )
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<div onclick')
    expect(html).toContain('&lt;img src=x onerror=')
  })

  it('行内原始 HTML（含 script 与 javascript: 锚点）转义为文本', async () => {
    const html = await renderMarkdown(
      'text <script>alert(1)</script> and <a href="javascript:alert(2)">x</a> end',
    )
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('javascript:alert(2)">x')
    expect(html).toContain('&lt;script&gt;')
  })

  it('markdown 链接的危险 scheme 降级为纯文本（含实体/大小写混淆）', async () => {
    const dangerous = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java&#115;cript:alert(1)',
      '&#106;avascript:alert(1)',
      'javascript&#58;alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    ]
    for (const href of dangerous) {
      const html = await renderMarkdown(`[click](${href})`)
      expect(html, href).not.toContain('<a href')
      expect(html, href).toContain('click')
    }
  })

  it('图片的危险 scheme 降级为 alt 文本', async () => {
    const html = await renderMarkdown('![alt](javascript:alert(1))')
    expect(html).not.toContain('<img')
    expect(html).toContain('alt')
  })

  it('安全链接保持可点击（http/相对/锚点/内部 scheme）', async () => {
    const safe: Array<[string, string]> = [
      ['[a](https://example.com/x)', 'href="https://example.com/x"'],
      ['[a](./rel.md)', 'href="./rel.md"'],
      ['[a](#anchor)', 'href="#anchor"'],
      ['[a](skill://foo)', 'href="skill://foo"'],
      ['[a](mailto:x@y.z)', 'href="mailto:x@y.z"'],
    ]
    for (const [md, expectHref] of safe) {
      const html = await renderMarkdown(md)
      expect(html, md).toContain(expectHref)
    }
  })

  it('renderMarkdownSync 同口径：原始 HTML 与危险 scheme 同样被拦截', () => {
    const html = renderMarkdownSync('<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1))')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<a href')
    expect(html).toContain('&lt;img')
  })
})

// 复现：Markdown 组件此前持有模块级无界 Map（mdCache）——流式渲染期间
// AssistantTextBlock 的每个 text_delta 中间版本都以完整文本为 key 写入且
// 永不驱逐：长会话数千条完整 HTML 常驻内存，只增不减。同型参照
// highlight.ts 的 hlCache（200 上限 + 驱逐最旧）——此处收敛为同口径有界缓存。
describe('renderMarkdownCached', () => {
  it('相同内容命中缓存，不再重复高亮', async () => {
    const { highlightCode } = await import('@/utils/highlight.js')
    const mocked = vi.mocked(highlightCode)
    mocked.mockClear()
    const md = '```ts\nconst a = 1\n```'
    await renderMarkdownCached(md)
    await renderMarkdownCached(md)
    expect(mocked).toHaveBeenCalledTimes(1)
  })

  it('缓存容量有界：插入超上限后驱逐最旧，size 不超过上限', async () => {
    for (let i = 0; i < 250; i += 1) {
      await renderMarkdownCached(`unique-${i}`)
    }
    expect(markdownCacheSize()).toBeLessThanOrEqual(200)
  })
})
