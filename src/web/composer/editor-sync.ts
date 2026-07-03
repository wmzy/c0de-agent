import { css } from '@linaria/core'
import { getCursorPosition, setCursorPosition } from './editor-dom.js'
import type { Prompt, SnippetPart } from './types.js'
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

/** pill 公共样式（file 与 snippet pill 共用），hover 时有底色提示可交互。 */
const pillStyle = css`
  display: inline-block;
  padding: 1px 6px;
  margin: 0 2px;
  border-radius: 4px;
  background: var(--bg-tertiary, #e8e8e8);
  color: var(--primary, #4a9eff);
  font-size: 0.92em;
  user-select: none;
  cursor: pointer;
  &:hover {
    background: var(--primary, #4a9eff);
    color: #fff;
  }
`

/** 创建 snippet pill 元素（显示位置标签，snippet 存 data 属性供 hover/click 使用）。
 * 注意：pill 内不能放任何额外子节点，否则 editor-dom 的 getTextLength 会把子节点文本
 * 计入光标偏移，破坏光标定位。hover tooltip 由 ComposerEditor 在 pill 外层渲染。 */
function createSnippetPill(part: SnippetPart): HTMLSpanElement {
  const span = document.createElement('span')
  span.setAttribute('data-type', 'snippet')
  span.setAttribute('data-path', part.path)
  span.setAttribute('data-line-start', String(part.lineStart))
  span.setAttribute('data-line-end', String(part.lineEnd))
  span.setAttribute('data-snippet', part.snippet)
  span.setAttribute('contenteditable', 'false')
  span.className = pillStyle
  span.textContent = part.label
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
    if (el.dataset.type === 'snippet') {
      flushText()
      const label = el.textContent ?? ''
      parts.push({
        type: 'snippet',
        path: el.dataset.path ?? '',
        lineStart: Number(el.dataset.lineStart ?? '1'),
        lineEnd: Number(el.dataset.lineEnd ?? '1'),
        label,
        snippet: el.dataset.snippet ?? '',
        start: position,
        end: position + label.length,
      })
      position += label.length
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
    } else if (part.type === 'snippet') {
      editor.appendChild(createSnippetPill(part))
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
