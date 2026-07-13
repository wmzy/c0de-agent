import { css } from '@linaria/core'
import { getCursorPosition, setCursorPosition } from './editor-dom.js'
import type { Prompt, SnippetPart, TerminalPart } from './types.js'
import { DEFAULT_PROMPT } from './types.js'

/** workflowz 高亮样式：琥珀→翠绿渐变文字，与 oh-my-pi 的 hue 30→150 一致。 */
const wfHighlight = css`
  background: linear-gradient(135deg, #f59e0b, #10b981);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  font-weight: 600;
`

/** 全局匹配 workflowz 关键词（非代码块/路径内的独立词）。 */
const WORKFLOW_GLOBAL = /(?<![\w./-])workflowz(?![\w./-])/g

/**
 * 在 contentEditable 编辑器中高亮所有 workflowz 关键词。
 *
 * 幂等：先 unwrap 已有 [data-wf] 装饰 span，再重新扫描文本节点包裹。
 * 保存/恢复光标位置（按字符偏移），避免 DOM 结构变更影响光标。
 * 跳过 pill 元素（contenteditable=false）内的文本。
 */
function decorateWorkflowz(editor: HTMLElement): void {
  // 快速路径：没有 workflowz 关键词也没有残留装饰 span 时，
  // 不需要修改 DOM，也不应保存/恢复光标（setCursorPosition 的零宽空格
  // 映射会导致光标偏移）。这是最高频路径——绝大多数按键不涉及 workflowz。
  const hasKeyword = /workflowz/.test(editor.textContent ?? '')
  const hasStaleSpan = editor.querySelector('[data-wf]') !== null
  if (!hasKeyword && !hasStaleSpan) return

  const cursor = getCursorPosition(editor)

  // 1. unwrap 已有 [data-wf] span → 纯文本节点
  for (const el of Array.from(editor.querySelectorAll('[data-wf]'))) {
    const text = el.textContent ?? ''
    el.replaceWith(document.createTextNode(text))
  }
  editor.normalize()

  // 2. 收集需要装饰的文本节点
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement?.closest('[contenteditable="false"]')) return NodeFilter.FILTER_REJECT
      return /workflowz/.test(node.textContent ?? '')
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT
    },
  })

  // 3. 在每个文本节点中包裹所有匹配（收集后处理，避免 walker 失效）
  const targets: Text[] = []
  let n: Node | null = walker.nextNode()
  while (n) {
    targets.push(n as Text)
    n = walker.nextNode()
  }

  for (const textNode of targets) {
    const text = textNode.textContent ?? ''
    const segments: { text: string; highlight: boolean }[] = []
    let lastEnd = 0
    WORKFLOW_GLOBAL.lastIndex = 0
    let m: RegExpExecArray | null = WORKFLOW_GLOBAL.exec(text)
    while (m) {
      if (m.index > lastEnd) segments.push({ text: text.slice(lastEnd, m.index), highlight: false })
      segments.push({ text: m[0], highlight: true })
      lastEnd = m.index + m[0].length
      m = WORKFLOW_GLOBAL.exec(text)
    }
    if (segments.length === 0) continue
    if (lastEnd < text.length) segments.push({ text: text.slice(lastEnd), highlight: false })

    // 用 segment 替换原文本节点
    const frag = document.createDocumentFragment()
    for (const seg of segments) {
      if (seg.highlight) {
        const span = document.createElement('span')
        span.dataset.wf = '1'
        span.className = wfHighlight
        span.textContent = seg.text
        frag.appendChild(span)
      } else {
        frag.appendChild(document.createTextNode(seg.text))
      }
    }
    textNode.replaceWith(frag)
  }

  setCursorPosition(editor, cursor)
}

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

/** 创建 terminal pill 元素（显示 label，content 存 data 属性）。
 * 复用 snippet/file pill 的 pillStyle 样式。 */
function createTerminalPill(part: TerminalPart): HTMLSpanElement {
  const span = document.createElement('span')
  span.setAttribute('data-type', 'terminal')
  span.setAttribute('data-content', part.content)
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
    if (el.dataset.type === 'terminal') {
      flushText()
      const label = el.textContent ?? ''
      parts.push({
        type: 'terminal',
        label,
        content: el.dataset.content ?? '',
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
    } else if (part.type === 'terminal') {
      editor.appendChild(createTerminalPill(part))
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

export { currentCursor, decorateWorkflowz, parseFromDOM, reconcile, renderPrompt }
