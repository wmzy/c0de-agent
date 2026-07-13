import { afterEach, describe, expect, it } from 'vitest'
import { decorateWorkflowz, parseFromDOM, renderPrompt } from './editor-sync.js'
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

  it('snippet pill 的 start/end 基于其 textContent 长度', () => {
    const el = makeEditor('<span data-type="file" data-path="a.ts">FILE</span>')
    const prompt = parseFromDOM(el)
    const file = prompt.find((p) => p.type === 'file')
    expect(file).toBeTruthy()
    if (file && file.type === 'file') {
      expect(file.start).toBe(0)
      expect(file.end).toBe(4)
    }
  })

  it('terminal pill 解析为 TerminalPart（含 label/content）', () => {
    const el = makeEditor(
      'x<span data-type="terminal" data-content="$ npm test\n✓ passed">🖥 命令: npm test</span>y',
    )
    const prompt = parseFromDOM(el)
    const terminal = prompt.find((p) => p.type === 'terminal')
    expect(terminal && terminal.type === 'terminal').toBeTruthy()
    if (terminal && terminal.type === 'terminal') {
      expect(terminal.label).toBe('🖥 命令: npm test')
      expect(terminal.content).toBe('$ npm test\n✓ passed')
      expect(terminal.start).toBe(1)
      expect(terminal.end).toBe(1 + '🖥 命令: npm test'.length)
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

  it('TerminalPart 渲染为带 data 属性的 terminal pill', () => {
    const el = makeEditor('')
    const prompt: Prompt = [
      {
        type: 'terminal',
        label: '🖥 终端选区',
        content: 'hello world',
        start: 0,
        end: 6,
      },
    ]
    renderPrompt(el, prompt)
    const pill = el.querySelector('[data-type="terminal"]')
    expect(pill).toBeTruthy()
    expect(pill?.getAttribute('data-content')).toBe('hello world')
    expect(pill?.textContent).toBe('🖥 终端选区')
    expect(pill?.getAttribute('contenteditable')).toBe('false')
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

  it('terminal pill 提交时展开为 terminal 代码块', () => {
    const prompt: Prompt = [
      { type: 'text', content: '分析这个 ', start: 0, end: 5 },
      {
        type: 'terminal',
        label: '🖥 命令: npm test',
        content: '$ npm test\n✓ all passed',
        start: 5,
        end: 5 + '🖥 命令: npm test'.length,
      },
    ]
    expect(promptToText(prompt)).toBe('分析这个 🖥 命令: npm test')
    expect(promptToMessageText(prompt)).toBe('分析这个 ```terminal\n$ npm test\n✓ all passed\n```')
  })
})

describe('decorateWorkflowz', () => {
  it('包裹独立 workflowz 关键词', () => {
    const el = makeEditor('please workflowz this')
    decorateWorkflowz(el)
    const span = el.querySelector('[data-wf]')
    expect(span).not.toBeNull()
    expect(span?.textContent).toBe('workflowz')
  })

  it('中文混排也匹配', () => {
    const el = makeEditor('请workflowz，部署')
    decorateWorkflowz(el)
    const span = el.querySelector('[data-wf]')
    expect(span?.textContent).toBe('workflowz')
  })

  it('不匹配 workflowzed / reworkflowz / 路径', () => {
    const el = makeEditor('workflowzed reworkflowz workflowz.test.ts')
    decorateWorkflowz(el)
    expect(el.querySelector('[data-wf]')).toBeNull()
  })

  it('多次匹配全部包裹', () => {
    const el = makeEditor('workflowz and workflowz')
    decorateWorkflowz(el)
    expect(el.querySelectorAll('[data-wf]')).toHaveLength(2)
  })

  it('幂等：重复调用不产生嵌套 span', () => {
    const el = makeEditor('workflowz here')
    decorateWorkflowz(el)
    decorateWorkflowz(el)
    expect(el.querySelectorAll('[data-wf]')).toHaveLength(1)
    // parseFromDOM 仍能正确提取文本
    expect(promptToText(parseFromDOM(el))).toBe('workflowz here')
  })

  it('parseFromDOM 不受装饰 span 影响', () => {
    const el = makeEditor('hello workflowz world')
    decorateWorkflowz(el)
    const prompt = parseFromDOM(el)
    expect(promptToText(prompt)).toBe('hello workflowz world')
  })
})
