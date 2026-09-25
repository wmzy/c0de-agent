const ZERO_WIDTH = /\u200B/g

/** 块级元素标签（浏览器段落分隔）。Chrome 对多行文本执行
 *  `document.execCommand('insertText', false, 'a\nb')` 的产物除首行外每行包一个
 *  `<div>`（实测 Chromium；Composer 的小段多行粘贴正走这条路径），因此块级
 *  元素的边界就是文本流里的换行——DOM→文本/偏移/光标三处必须同口径。 */
const BLOCK_TAGS = new Set(['DIV', 'P'])

/** 节点是否为块级元素。 */
export function isBlockElement(node: Node): node is HTMLElement {
  return node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((node as HTMLElement).tagName)
}

/** 块级子节点贡献的前导换行长度：块内容另起一行；容器首个子节点（无前驱）
 *  不产生前导空行（与浏览器 innerText 的块边界口径一致）。 */
export function blockBoundaryLength(node: Node): number {
  return isBlockElement(node) && node.previousSibling !== null ? 1 : 0
}

/** 块内末位的 <br> 是否冗余：该行已由块边界表达（空行块 `<div><br></div>`、
 *  行尾软换行），重复计换行会让粘贴文本凭空多出空行。 */
export function isRedundantTrailingBr(block: Node, child: Node): boolean {
  return (
    block.lastChild === child &&
    child.nodeType === Node.ELEMENT_NODE &&
    (child as HTMLElement).tagName === 'BR'
  )
}

/** 剔除零宽空格后的长度。 */
function strippedLength(text: string): number {
  return text.includes('\u200B') ? text.replace(ZERO_WIDTH, '').length : text.length
}

/** 文本节点在 [0, rawOffset) 内的长度（零宽空格不计）。 */
function strippedPrefixLength(text: string, rawOffset: number): number {
  const end = Math.min(Math.max(rawOffset, 0), text.length)
  let stripped = 0
  for (let i = 0; i < end; i++) {
    if (text[i] !== '\u200B') stripped++
  }
  return stripped
}

/** 节点**自身内容**的文本流长度（不含它作为子节点时的块边界换行）：
 *  文本剔除零宽空格、BR 算 1、元素递归累加子节点（含子节点的块边界）。
 *  `isRoot`：遍历根（编辑器）——根不是任何块级父节点的子节点，其自身末位 <br>
 *  是「文本以换行结尾」的唯一表达（renderPrompt 的 `a<br>`），不得按冗余规则吃掉。 */
function getTextLength(node: Node, isRoot = true): number {
  if (node.nodeType === Node.TEXT_NODE) return strippedLength(node.textContent ?? '')
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'BR') return 1
  let length = 0
  for (const child of textChildren(node, isRoot)) length += childTextLength(child)
  return length
}

/** 子节点在文本流中的长度：块级子节点的前导换行 + 其自身内容。
 *  （边界挂在子节点上——根节点自身不产生前导换行。） */
function childTextLength(child: Node): number {
  return blockBoundaryLength(child) + getTextLength(child, false)
}

/** 节点内参与文本流的子节点（块内末位 <br> 冗余，不计入；遍历根除外）。 */
function textChildren(el: Node, isRoot: boolean): Node[] {
  const kids = Array.from(el.childNodes)
  return !isRoot && isBlockElement(el)
    ? kids.filter((child) => !isRedundantTrailingBr(el, child))
    : kids
}

/**
 * 累计「parent 起点 → (container, offset) 点」的字符偏移；未命中返回 null。
 *
 * 与 setCursorPosition 同一模型（BR 算 1、块边界算 1、块内末位 BR 不计、零宽空格
 * 不计），且**不用 `Range.cloneContents()`**：部分克隆会把块内中间的 `<br>` 变成
 * 克隆子树的末位 `<br>`，被「末位 BR 冗余」规则吃掉——光标落在 `l4<br>l5` 的换行
 * 之后时偏移少 1（setCursor→getCursor 往返失配）。
 */
function offsetOfPoint(parent: Node, container: Node, offset: number): number | null {
  let position = 0
  let found: number | null = null

  const walk = (node: Node, isRoot: boolean): void => {
    if (found !== null) return
    if (node.nodeType === Node.TEXT_NODE) {
      if (node === container) {
        found = position + strippedPrefixLength(node.textContent ?? '', offset)
        return
      }
      position += strippedLength(node.textContent ?? '')
      return
    }
    if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'BR') {
      if (node === container) {
        found = position + Math.min(offset, 1)
        return
      }
      position += 1
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    const kids = textChildren(el, isRoot)
    // 根节点自身的块边界不属于 parent 内的文本流（父级在编辑器之外）
    if (!isRoot) position += blockBoundaryLength(el)
    // 光标落在本元素的子节点间隙（container 即本元素）：= 本元素块边界 + 前 offset
    // 个子节点长度之和（光标在本元素内部，已在块边界之后）。
    if (el === container) {
      const limit = Math.min(Math.max(offset, 0), kids.length)
      for (let i = 0; i < limit; i++) {
        const child = kids[i]
        if (child) position += childTextLength(child)
      }
      found = position
      return
    }
    for (const child of kids) {
      walk(child, false)
      if (found !== null) return
    }
  }

  walk(parent, true)
  return found
}

/** 读取光标在 parent 内的字符偏移（BR 算 1，块边界算 1，零宽空格不计）。 */
function getCursorPosition(parent: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  if (!parent.contains(range.startContainer)) return 0
  return offsetOfPoint(parent, range.startContainer, range.startOffset) ?? 0
}

/** 把光标设到 parent 内的字符偏移 position。
 *  `isRoot`：parent 为遍历根（编辑器）——根的末位 <br> 不是冗余换行（见 getTextLength）。 */
function setCursorPosition(parent: HTMLElement, position: number, isRoot = true): void {
  let remaining = position
  let node: Node | null = parent.firstChild

  while (node) {
    // 块级子节点：块内容另起一行，前驱存在时占 1 个偏移（与 getTextLength 同口径）。
    // 偏移正好落在该换行上（remaining === 0）→ 光标落在块内容之前。
    const boundary = blockBoundaryLength(node)
    if (boundary > 0 && remaining === 0) {
      const range = document.createRange()
      const sel = window.getSelection()
      range.setStartBefore(node)
      range.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(range)
      return
    }
    remaining -= boundary
    // 块内末位 <br> 不计长度（该行已由块边界表达）：跳过，避免吃掉偏移。
    if (!isRoot && isBlockElement(parent) && isRedundantTrailingBr(parent, node)) {
      node = node.nextSibling
      continue
    }
    let nodeLen: number
    if (node.nodeType === Node.TEXT_NODE) {
      nodeLen = (node.textContent ?? '').replace(ZERO_WIDTH, '').length
    } else if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'BR') {
      nodeLen = 1
    } else {
      // 内容长度（不含已单独消费的块边界；本节点是子节点，末位 BR 按冗余规则
      // 剔除——否则递归会带着多 1 的偏移进块，光标落到块内容末尾而非行首）。
      nodeLen = getTextLength(node, false)
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
      setCursorPosition(node as HTMLElement, remaining, false)
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
