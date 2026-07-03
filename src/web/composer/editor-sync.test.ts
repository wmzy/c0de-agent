import { afterEach, describe, expect, it } from 'vitest'
import { parseFromDOM, renderPrompt } from './editor-sync.js'
import type { Prompt } from './types.js'
import { DEFAULT_PROMPT, promptToMessageText, promptToText } from './types.js'

function makeEditor(html = ''): HTMLDivElement {
  const el = document.createElement('div')
  el.contentEditable = 'true'
  el.innerHTML = html
  return el
}

afterEach(() => document.body.replaceChildren())

describe('parseFromDOM', () => {
  it('空 DOM 返回 DEFAULT_PROMPT', () => {
    expect(parseFromDOM(makeEditor(''))).toEqual(DEFAULT_PROMPT)
  })

  it('纯文本解析为单个 TextPart', () => {
    const el = makeEditor('hello')
    const prompt = parseFromDOM(el)
    expect(prompt).toHaveLength(1)
    expect(prompt[0]).toMatchObject({ type: 'text', content: 'hello', start: 0, end: 5 })
  })

  it('<br> 解析为换行', () => {
    const el = makeEditor('a<br>b')
    const prompt = parseFromDOM(el)
    const text = prompt.find((p) => p.type === 'text')
    expect(text && text.type === 'text' && text.content).toBe('a\nb')
  })

  it('file pill 解析为 FilePart', () => {
    const el = makeEditor('x<span data-type="file" data-path="src/a.ts">src/a.ts</span>y')
    const prompt = parseFromDOM(el)
    const file = prompt.find((p) => p.type === 'file')
    expect(file).toBeTruthy()
    expect(file && file.type === 'file' ? file.path : '').toBe('src/a.ts')
  })

  it('file pill 的 start/end 基于其 textContent 长度', () => {
    const el = makeEditor('<span data-type="file" data-path="a.ts">FILE</span>')
    const prompt = parseFromDOM(el)
    const file = prompt.find((p) => p.type === 'file')
    expect(file).toBeTruthy()
    if (file && file.type === 'file') {
      expect(file.start).toBe(0)
      expect(file.end).toBe(4)
    }
  })

  it('snippet pill 解析为 SnippetPart（含 path/行号/snippet）', () => {
    const el = makeEditor(
      'x<span data-type="snippet" data-path="a.ts" data-line-start="5" data-line-end="10" data-snippet="const x = 1">📄 a.ts:5-10</span>y',
    )
    const prompt = parseFromDOM(el)
    const snippet = prompt.find((p) => p.type === 'snippet')
    expect(snippet && snippet.type === 'snippet').toBeTruthy()
    if (snippet && snippet.type === 'snippet') {
      expect(snippet.path).toBe('a.ts')
      expect(snippet.lineStart).toBe(5)
      expect(snippet.lineEnd).toBe(10)
      expect(snippet.label).toBe('📄 a.ts:5-10')
      expect(snippet.snippet).toBe('const x = 1')
      expect(snippet.start).toBe(1)
      expect(snippet.end).toBe(1 + '📄 a.ts:5-10'.length)
    }
  })
})

describe('renderPrompt', () => {
  it('把 Prompt 渲染回 DOM（text + file pill）', () => {
    const el = makeEditor('')
    const prompt: Prompt = [
      { type: 'text', content: 'hi ', start: 0, end: 3 },
      { type: 'file', path: 'a.ts', content: 'A', start: 3, end: 4 },
    ]
    renderPrompt(el, prompt)
    const pill = el.querySelector('[data-type="file"]')
    expect(pill).toBeTruthy()
    expect(pill?.getAttribute('data-path')).toBe('a.ts')
  })

  it('DEFAULT_PROMPT 渲染为空', () => {
    const el = makeEditor('leftover')
    renderPrompt(el, DEFAULT_PROMPT)
    expect(el.textContent?.replace(/\u200B/g, '')).toBe('')
  })

  it('SnippetPart 渲染为带 data 属性的 snippet pill', () => {
    const el = makeEditor('')
    const prompt: Prompt = [
      {
        type: 'snippet',
        path: 'a.ts',
        lineStart: 5,
        lineEnd: 5,
        label: '📄 a.ts:5',
        snippet: 'const x = 1',
        start: 0,
        end: 9,
      },
    ]
    renderPrompt(el, prompt)
    const pill = el.querySelector('[data-type="snippet"]')
    expect(pill).toBeTruthy()
    expect(pill?.getAttribute('data-path')).toBe('a.ts')
    expect(pill?.getAttribute('data-line-start')).toBe('5')
    expect(pill?.getAttribute('data-line-end')).toBe('5')
    expect(pill?.getAttribute('data-snippet')).toBe('const x = 1')
    expect(pill?.textContent).toBe('📄 a.ts:5')
  })
})

describe('promptToMessageText', () => {
  it('snippet pill 提交时展开为带行号标注的代码块（省一次 read 调用）', () => {
    const prompt: Prompt = [
      { type: 'text', content: '看这段代码 ', start: 0, end: 6 },
      {
        type: 'snippet',
        path: 'src/a.ts',
        lineStart: 5,
        lineEnd: 10,
        label: '📄 src/a.ts:5-10',
        snippet: 'const x = 1\nconst y = 2',
        start: 6,
        end: 22,
      },
    ]
    // 编辑器内只看到标签（promptToText）
    expect(promptToText(prompt)).toBe('看这段代码 📄 src/a.ts:5-10')
    // 提交时展开为完整代码块
    expect(promptToMessageText(prompt)).toBe(
      '看这段代码 📄 `src/a.ts:5-10`:\n```\nconst x = 1\nconst y = 2\n```',
    )
  })

  it('单行选区标签为 path:N 格式', () => {
    const prompt: Prompt = [
      {
        type: 'snippet',
        path: 'b.ts',
        lineStart: 3,
        lineEnd: 3,
        label: '📄 b.ts:3',
        snippet: 'x',
        start: 0,
        end: 8,
      },
    ]
    expect(promptToMessageText(prompt)).toBe('📄 `b.ts:3`:\n```\nx\n```')
  })
})
