import { describe, expect, it, vi } from 'vitest'

// Mock shiki 高亮：返回可识别的 HTML，隔离测试 marked 异步集成机制本身。
// 核心回归点是 marked 的 async 处理，与 shiki 实现无关。
vi.mock('./highlight.js', () => ({
  highlightCode: vi.fn(
    async (code: string, lang: string) => `<pre data-mock-lang="${lang}">${code}</pre>`,
  ),
}))

// Mock 必须在 import 之前生效
const { renderMarkdown, renderMarkdownSync } = await import('./markdown.js')

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
})
