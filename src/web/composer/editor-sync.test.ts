import { afterEach, describe, expect, it } from 'vitest'
import { parseFromDOM, renderPrompt } from './editor-sync.js'
import type { Prompt } from './types.js'
import { DEFAULT_PROMPT } from './types.js'

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
})
