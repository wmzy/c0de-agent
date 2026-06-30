import { afterEach, describe, expect, it } from 'vitest'
import { getCursorPosition, setCursorPosition } from './editor-dom.js'

afterEach(() => document.body.replaceChildren())

function makeEditor(html: string): HTMLDivElement {
  const el = document.createElement('div')
  el.contentEditable = 'true'
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

describe('光标往返一致性', () => {
  it('纯文本 setCursor→getCursor 等值', () => {
    const el = makeEditor('hello world')
    setCursorPosition(el, 5)
    expect(getCursorPosition(el)).toBe(5)
    setCursorPosition(el, 0)
    expect(getCursorPosition(el)).toBe(0)
  })

  it('含 <br> 的偏移计算（BR 算 1）', () => {
    const el = makeEditor('aa<br>bb')
    // 偏移 2 = 在 'aa' 之后（BR 之前）
    setCursorPosition(el, 2)
    expect(getCursorPosition(el)).toBe(2)
    // 偏移 3 = BR 之后
    setCursorPosition(el, 3)
    expect(getCursorPosition(el)).toBe(3)
  })

  it('超出长度时落在末尾', () => {
    const el = makeEditor('abc')
    setCursorPosition(el, 999)
    expect(getCursorPosition(el)).toBe(3)
  })
})
