const ZERO_WIDTH = /\u200B/g

/** 文本节点长度（剔除零宽空格）；BR 算 1；元素递归累加。 */
function getTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').replace(ZERO_WIDTH, '').length
  }
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'BR') return 1
  let length = 0
  for (const child of Array.from(node.childNodes)) length += getTextLength(child)
  return length
}

/** 读取光标在 parent 内的字符偏移（BR 算 1，零宽空格不计）。 */
function getCursorPosition(parent: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  if (!parent.contains(range.startContainer)) return 0
  const preCaretRange = range.cloneRange()
  preCaretRange.selectNodeContents(parent)
  preCaretRange.setEnd(range.startContainer, range.startOffset)
  return getTextLength(preCaretRange.cloneContents())
}

/** 把光标设到 parent 内的字符偏移 position。 */
function setCursorPosition(parent: HTMLElement, position: number): void {
  let remaining = position
  let node: Node | null = parent.firstChild

  while (node) {
    let nodeLen: number
    if (node.nodeType === Node.TEXT_NODE) {
      nodeLen = (node.textContent ?? '').replace(ZERO_WIDTH, '').length
    } else if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'BR') {
      nodeLen = 1
    } else {
      nodeLen = getTextLength(node)
    }

    // 文本节点内定位
    if (remaining <= nodeLen && node.nodeType === Node.TEXT_NODE) {
      const range = document.createRange()
      const sel = window.getSelection()
      const textNode = node
      // remaining 是剔除零宽空格后的偏移，需映射回原始 offset（跳过 \u200B）。
      // 旧代码直接用 remaining 作为 offset，遇到零宽空格时光标会少移一位。
      const text = textNode.textContent ?? ''
      let rawOffset = 0
      let stripped = 0
      while (rawOffset < text.length && stripped < remaining) {
        if (text[rawOffset] !== '\u200B') stripped++
        rawOffset++
      }
      range.setStart(textNode, rawOffset)
      range.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(range)
      return
    }
    // BR 节点处定位：remaining === nodeLen 落在 BR 之后，否则（=0）
    // 落在 BR 之前——此前一律 setStartAfter，起始位置（编辑器首行为 BR
    // 时偏移 0）被弹到 BR 之后。
    if (
      remaining <= nodeLen &&
      node.nodeType === Node.ELEMENT_NODE &&
      (node as HTMLElement).tagName === 'BR'
    ) {
      const range = document.createRange()
      const sel = window.getSelection()
      if (remaining === nodeLen) {
        range.setStartAfter(node)
      } else {
        range.setStartBefore(node)
      }
      range.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(range)
      return
    }
    // 偏移落在嵌套元素（workflowz 高亮 span、粘贴带来的格式化 span 等）
    // 内部：递归下钻到该元素继续定位。此前整段减掉元素长度后继续走兄弟
    // 节点——元素内的偏移全部坠到编辑器末尾，光标恢复把光标从原位弹到
    // 消息末尾（getTextLength 递归计数、set 方向也必须递归定位，双向口径
    // 一致才保证往返）。
    if (remaining <= nodeLen && node.nodeType === Node.ELEMENT_NODE) {
      setCursorPosition(node as HTMLElement, remaining)
      return
    }
    remaining -= nodeLen
    node = node.nextSibling
  }

  // fallback：落在末尾
  const range = document.createRange()
  const sel = window.getSelection()
  range.selectNodeContents(parent)
  range.collapse(false)
  sel?.removeAllRanges()
  sel?.addRange(range)
}

export { getCursorPosition, getTextLength, setCursorPosition }
