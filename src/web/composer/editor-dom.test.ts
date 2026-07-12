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

describe('零宽空格 (\u200B) 光标处理', () => {
  it('含零宽空格时 setCursor→getCursor 往返一致', () => {
    // 编辑器初始化时插入 \u200B 防塌陷，输入后 DOM 为 '\u200Bhello'
    const el = makeEditor('\u200Bhello')
    // 光标应能落在末尾（stripped offset 5）
    setCursorPosition(el, 5)
    expect(getCursorPosition(el)).toBe(5)
    // 光标应能落在开头（stripped offset 0）
    setCursorPosition(el, 0)
    expect(getCursorPosition(el)).toBe(0)
    // 中间位置
    setCursorPosition(el, 2)
    expect(getCursorPosition(el)).toBe(2)
  })

  it('只有零宽空格时光标在开头', () => {
    const el = makeEditor('\u200B')
    setCursorPosition(el, 0)
    expect(getCursorPosition(el)).toBe(0)
  })

  it('零宽空格后单个字符（输入 / 的场景）', () => {
    const el = makeEditor('\u200B/')
    setCursorPosition(el, 1)
    expect(getCursorPosition(el)).toBe(1)
  })
})
