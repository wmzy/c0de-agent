import { afterEach, describe, expect, it } from 'vitest'
import { getCursorPosition, setCursorPosition } from '@/composer/editor-dom.js'

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

describe('嵌套元素内的光标定位', () => {
  // 复现：setCursorPosition 只在节点本身是文本节点时定位，落在嵌套元素
  // （workflowz 高亮 [data-wf] span、粘贴带来的格式化 span 等）内部的偏移
  // 整段减掉该元素长度后继续走兄弟节点——位置坠到编辑器末尾。光标恢复
  // （decorateWorkflowz / reconcile 的 save→restore）在含嵌套 span 的编辑器
  // 里把光标从原位弹到消息末尾。
  it('嵌套 span 内部偏移往返一致', () => {
    const el = makeEditor('aa<span>bbb</span>cc')
    // 偏移 4 = span 内第 2 个字符（'aa'=2，span 内 'b' 从 3 开始）
    for (const pos of [0, 1, 2, 3, 4, 5, 6, 7]) {
      setCursorPosition(el, pos)
      expect(getCursorPosition(el)).toBe(pos)
    }
  })

  it('高亮 span（data-wf）内/后的偏移往返一致', () => {
    const el = makeEditor('hello <span data-wf="1">workflowz</span> end')
    for (const pos of [0, 6, 8, 12, 15, 18]) {
      setCursorPosition(el, pos)
      expect(getCursorPosition(el)).toBe(pos)
    }
  })

  it('BR 与嵌套 span 混排的偏移往返一致', () => {
    const el = makeEditor('<br><span>baaaa a</span>')
    // BR=1，span 内容 7 字符 → 总长 8
    for (const pos of [0, 1, 2, 4, 7, 8]) {
      setCursorPosition(el, pos)
      expect(getCursorPosition(el)).toBe(pos)
    }
  })

  it('深层嵌套元素内偏移往返一致', () => {
    const el = makeEditor('x<span>a<span>b<span>c</span>d</span>e</span>y')
    for (const pos of [0, 1, 2, 3, 4, 5, 6, 7]) {
      setCursorPosition(el, pos)
      expect(getCursorPosition(el)).toBe(pos)
    }
  })
})
