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
      const offset = Math.min(remaining, (node.textContent ?? '').length)
      range.setStart(textNode, offset)
      range.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(range)
      return
    }
    // BR 节点处定位（落在 BR 之后）
    if (
      remaining <= nodeLen &&
      node.nodeType === Node.ELEMENT_NODE &&
      (node as HTMLElement).tagName === 'BR'
    ) {
      const range = document.createRange()
      const sel = window.getSelection()
      range.setStartAfter(node)
      range.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(range)
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
