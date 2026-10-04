import { afterEach, describe, expect, it } from 'vitest'
import { getCursorPosition, getTextLength, setCursorPosition } from '@/composer/editor-dom.js'
import { parseFromDOM } from '@/composer/editor-sync.js'
import { promptToText } from '@/composer/types.js'

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

describe('块级行分隔的偏移口径', () => {
  // 浏览器粘贴多行文本产生 <div> 行分隔（见 editor-sync.test.ts 的同名说明）。
  // 偏移模型必须与 parseFromDOM 的文本流同口径——否则光标偏移与 prompt 偏移
  // 错位（popover 的 @token 定位、replacePromptRange 替换范围全部偏移）。
  it('含 <div> 行分隔的 DOM 上 setCursor→getCursor 往返一致', () => {
    const el = makeEditor('aa<div>bb</div>')
    // 文本流 "aa\nbb"（长度 5）：偏移 2 = 行尾，3 = 次行行首
    for (const pos of [0, 1, 2, 3, 4, 5]) {
      setCursorPosition(el, pos)
      expect(getCursorPosition(el)).toBe(pos)
    }
  })

  it('多行块 DOM 的往返一致（含空行块与块内 <br>）', () => {
    const el = makeEditor('l1<div>l2</div><div><br></div><div>l4<br>l5</div>')
    for (const pos of [0, 2, 3, 4, 5, 6, 7, 9, 10, 11]) {
      setCursorPosition(el, pos)
      expect(getCursorPosition(el)).toBe(pos)
    }
  })

  it('偏移长度与 parseFromDOM 的文本流长度一致', () => {
    const cases = [
      'a',
      'a<br>b',
      'l1<div>l2</div>',
      'l1<div>l2</div><div>l3</div>',
      '<div>a</div><div>b</div>',
      'p<div><br></div>',
      'a<div><br></div><div>b</div>',
      'a<div>l1<br>l2</div>',
      'a<span>x</span><div>y</div>',
      '<div>a<div>b</div></div>',
      'a<div>b<br></div>',
      '\u200B',
    ]
    for (const html of cases) {
      const el = makeEditor(html)
      expect(getTextLength(el), html).toBe(promptToText(parseFromDOM(el)).length)
    }
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

describe('随机 DOM 的偏移往返（模糊测试）', () => {
  /** 确定性 PRNG（xorshift32）：失败可复现，不依赖随机种子。 */
  function makeRandom(seed: number): () => number {
    let state = seed
    return () => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return (state >>> 0) / 0x100000000
    }
  }

  /** 随机生成一段 DOM：文本 / <br> / 块级行（<div>/<p>）/ 嵌套 span / 零宽空格。 */
  function randomHtml(rnd: () => number, depth = 0): string {
    let html = ''
    const count = 1 + Math.floor(rnd() * 4)
    for (let i = 0; i < count; i++) {
      const pick = rnd()
      // depth>=2 是深度上限：只产叶子，不再递归。此前写成
      // `pick < 0.8 || depth >= 2`——depth>=2 时所有非文本/br 分支
      // 都走块级递归，分支过程超临界（平均后代 >1），DOM 指数膨胀
      // （实测单轮达 8 万字符），每轮再对每个偏移做 O(DOM) 的
      // set+get 往返，模糊测试整体挂死（CI 超 46 分钟不出结果）。
      if (pick < 0.4 || depth >= 2) {
        html += ['a', 'bc', 'l1', 'x y', '​', '中'][Math.floor(rnd() * 6)] ?? 'a'
      } else if (pick < 0.6) {
        html += '<br>'
      } else if (pick < 0.8) {
        const tag = rnd() < 0.7 ? 'div' : 'p'
        html += `<${tag}>${randomHtml(rnd, depth + 1)}</${tag}>`
      } else {
        html += `<span>${randomHtml(rnd, depth + 1)}</span>`
      }
    }
    return html
  }

  it('setCursor→getCursor 往返一致，且偏移长度与 prompt 文本流一致', () => {
    const rnd = makeRandom(0x5eed)
    for (let round = 0; round < 120; round++) {
      const html = randomHtml(rnd)
      const el = makeEditor(html)
      const text = promptToText(parseFromDOM(el))
      expect(getTextLength(el), html).toBe(text.length)
      // 采样偏移（全量 + 边界）往返：光标偏移即 prompt 偏移
      const offsets = new Set<number>([0, 1, 2, 3])
      for (let p = 0; p <= text.length; p++) offsets.add(p)
      for (const p of offsets) {
        if (p > text.length) continue
        setCursorPosition(el, p)
        expect(getCursorPosition(el), `${html} @${p}`).toBe(p)
      }
    }
  })
})
