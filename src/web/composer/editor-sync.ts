import { getCursorPosition, setCursorPosition } from './editor-dom.js'
import type { Prompt } from './types.js'
import { DEFAULT_PROMPT } from './types.js'

/** 创建 file pill 元素（contenteditable=false，防光标进入）。 */
function createFilePill(path: string, label: string): HTMLSpanElement {
  const span = document.createElement('span')
  span.setAttribute('data-type', 'file')
  span.setAttribute('data-path', path)
  span.setAttribute('contenteditable', 'false')
  span.textContent = label
  return span
}

/** 把 contenteditable DOM 解析为 Prompt（DOM→状态）。 */
function parseFromDOM(editor: HTMLElement): Prompt {
  const parts: Prompt = []
  let position = 0
  let buffer = ''

  const flushText = () => {
    let content = buffer
    if (content.includes('\r')) content = content.replace(/\r\n?/g, '\n')
    if (content.includes('\u200B')) content = content.replace(/\u200B/g, '')
    buffer = ''
    if (!content) return
    parts.push({ type: 'text', content, start: position, end: position + content.length })
    position += content.length
  }

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer += node.textContent ?? ''
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    if (el.dataset.type === 'file') {
      flushText()
      const content = el.textContent ?? ''
      const path = el.dataset.path ?? ''
      parts.push({ type: 'file', path, content, start: position, end: position + content.length })
      position += content.length
      return
    }
    if (el.tagName === 'BR') {
      buffer += '\n'
      return
    }
    for (const child of Array.from(el.childNodes)) visit(child)
  }

  const children = Array.from(editor.childNodes)
  children.forEach((child, index) => {
    const isBlock =
      child.nodeType === Node.ELEMENT_NODE && ['DIV', 'P'].includes((child as HTMLElement).tagName)
    visit(child)
    if (isBlock && index < children.length - 1) buffer += '\n'
  })

  flushText()
  if (parts.length === 0) return [...DEFAULT_PROMPT]
  return parts
}

/** 把 Prompt 渲染回 DOM（状态→DOM），不处理光标。 */
function renderPrompt(editor: HTMLElement, prompt: Prompt): void {
  editor.textContent = ''
  for (const part of prompt) {
    if (part.type === 'text') {
      // 按行分割，行间插 <br>；空行用 <br> 占位
      const lines = part.content.split('\n')
      lines.forEach((line, i) => {
        if (i > 0) editor.appendChild(document.createElement('br'))
        if (line) editor.appendChild(document.createTextNode(line))
      })
    } else if (part.type === 'file') {
      editor.appendChild(createFilePill(part.path, part.content || `📄 ${part.path}`))
    }
  }
  // 空 editor 插零宽空格防塌陷
  if (editor.childNodes.length === 0) editor.appendChild(document.createTextNode('\u200B'))
}

/** 把 Prompt 渲染回 DOM 并恢复光标到 savedCursor 位置。 */
function reconcile(editor: HTMLElement, prompt: Prompt, savedCursor: number): void {
  renderPrompt(editor, prompt)
  setCursorPosition(editor, savedCursor)
}

/** 读取当前光标偏移。 */
function currentCursor(editor: HTMLElement): number {
  return getCursorPosition(editor)
}

export { currentCursor, parseFromDOM, reconcile, renderPrompt }
