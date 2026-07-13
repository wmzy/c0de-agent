import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { currentCursor, decorateWorkflowz, parseFromDOM, reconcile } from './editor-sync.js'
import {
  canNavigateHistoryAtCursor,
  loadHistory,
  navigatePromptHistory,
  prependHistoryEntry,
  saveHistory,
} from './history.js'
import { normalizePaste, pasteMode } from './paste.js'
import type { ImagePart, Prompt } from './types.js'
import {
  DEFAULT_PROMPT,
  isPromptEmpty,
  promptToMessageText,
  promptToText,
  snippetLabel,
} from './types.js'

type PopoverState = 'slash' | 'at' | 'workflow' | null

type UseComposerOptions = {
  onSend: (payload: { text: string; files: string[]; images: ImagePart[] }) => void
  onAbort?: () => void
  /** 流式态下「追加指令」注入 steering 文本（spec §3.9）。 */
  onSteer?: (message: string) => void
  isStreaming: boolean
  hasHistory: boolean
}

/** 把一段纯文本包成单 TextPart 的 Prompt（start/end 仅占位，renderPrompt 不读它们）。 */
function textPrompt(text: string): Prompt {
  return [{ type: 'text', content: text, start: 0, end: text.length }]
}

function useComposer({
  onSend,
  onAbort,
  onSteer,
  isStreaming,
  hasHistory: _hasHistory,
}: UseComposerOptions) {
  const editorRef = useRef<HTMLDivElement>(null)
  const promptRef = useRef<Prompt>(DEFAULT_PROMPT)
  const mirrorRef = useRef({ input: false })
  const composingRef = useRef(false)
  const [images, setImages] = useState<ImagePart[]>([])
  const [popover, setPopover] = useState<PopoverState>(null)
  const [popoverQuery, setPopoverQuery] = useState('')
  const [showPasteConfirm, setShowPasteConfirm] = useState<{ text: string } | null>(null)
  const [isEmpty, setIsEmpty] = useState(true)

  // 历史回溯导航状态
  const indexRef = useRef(-1)
  const draftRef = useRef('')
  const resetHistory = useCallback(() => {
    indexRef.current = -1
    draftRef.current = ''
  }, [])

  // 挂载后初始化空编辑器（插零宽空格防塌陷）
  useLayoutEffect(() => {
    if (editorRef.current && editorRef.current.childNodes.length === 0) {
      editorRef.current.appendChild(document.createTextNode('\u200B'))
    }
  }, [])

  const readPrompt = useCallback((): Prompt => {
    if (!editorRef.current) return DEFAULT_PROMPT
    return parseFromDOM(editorRef.current)
  }, [])

  const handleInput = useCallback(() => {
    if (!editorRef.current) return
    const prompt = parseFromDOM(editorRef.current)
    promptRef.current = prompt
    setIsEmpty(isPromptEmpty(prompt))
    resetHistory()

    const text = promptToText(prompt)
    const cursor = currentCursor(editorRef.current)

    // popover 触发检测（steer 模式不触发）
    const slashMatch = text.match(/^\/(\S*)$/)
    const atMatch = text.substring(0, cursor).match(/@(\S*)$/)
    // /workflow (run|show|edit) <name> — 补全工作流名称
    const workflowMatch = text.match(/^\/workflow\s+(run|show|edit)\s+(\S*)$/)
    if (workflowMatch) {
      setPopover('workflow')
      setPopoverQuery(workflowMatch[2] ?? '')
    } else if (slashMatch) {
      setPopover('slash')
      setPopoverQuery(slashMatch[1] ?? '')
    } else if (atMatch) {
      setPopover('at')
      setPopoverQuery(atMatch[1] ?? '')
    } else if (popover) {
      setPopover(null)
      setPopoverQuery('')
    }

    // workflowz 关键词高亮装饰（纯视觉，不影响 parse/cursor 逻辑）
    decorateWorkflowz(editorRef.current)
  }, [popover, resetHistory])

  const setPromptExternal = useCallback((prompt: Prompt, cursorAtEnd = false) => {
    if (!editorRef.current) return
    mirrorRef.current.input = true
    if (cursorAtEnd) {
      const totalLen = promptToText(prompt).length
      reconcile(editorRef.current, prompt, totalLen)
    } else {
      const cursor = currentCursor(editorRef.current)
      reconcile(editorRef.current, prompt, prompt === DEFAULT_PROMPT ? 0 : cursor)
    }
    promptRef.current = prompt
    setIsEmpty(isPromptEmpty(prompt))
    // 外部设置 prompt 后也需装饰
    if (editorRef.current) decorateWorkflowz(editorRef.current)
  }, [])

  // popover 选中插入命令（替换整行 /xxx）
  const insertSlash = useCallback(
    (name: string) => {
      setPromptExternal(textPrompt(`/${name} `), true)
      setPopover(null)
      editorRef.current?.focus()
    },
    [setPromptExternal],
  )

  // popover 选中插入工作流名称（保留 /workflow run/show/edit 前缀，仅替换查询部分）
  const insertWorkflow = useCallback(
    (name: string) => {
      const text = promptToText(promptRef.current)
      const match = text.match(/^(\/workflow\s+(?:run|show|edit)\s+)\S*$/)
      const prefix = match?.[1] ?? `/workflow run `
      setPromptExternal(textPrompt(`${prefix}${name} `), true)
      setPopover(null)
      editorRef.current?.focus()
    },
    [setPromptExternal],
  )

  // popover 选中插入文件 pill（替换 @query token）
  const insertFile = useCallback(
    (path: string) => {
      const text = promptToText(promptRef.current)
      const atIdx = text.lastIndexOf('@')
      if (atIdx === -1) return
      const before = text.slice(0, atIdx)
      // @token = '@' + 后续非空白字符
      let tokenEnd = atIdx + 1
      while (tokenEnd < text.length && !/\s/.test(text[tokenEnd] ?? '')) tokenEnd += 1
      const after = text.slice(tokenEnd)

      const newPrompt: Prompt = []
      let pos = 0
      const pushText = (content: string) => {
        if (!content) return
        newPrompt.push({ type: 'text', content, start: pos, end: pos + content.length })
        pos += content.length
      }
      pushText(before)
      newPrompt.push({ type: 'file', path, content: path, start: pos, end: pos + path.length })
      pos += path.length
      pushText(after)

      setPromptExternal(newPrompt)
      setPopover(null)
      editorRef.current?.focus()
    },
    [setPromptExternal],
  )

  /** 外部引用（文件树 @ 按钮）：在 prompt 末尾追加 file pill，无需 @ token。 */
  const appendFileReference = useCallback(
    (path: string) => {
      const prompt = promptRef.current
      const parts: Prompt = []
      for (const part of prompt) {
        if (part.type === 'text') parts.push({ ...part })
        else if (part.type === 'file') parts.push({ ...part })
      }
      const text = promptToText(prompt)
      if (text.length > 0 && !text.endsWith(' ')) {
        parts.push({ type: 'text', content: ' ', start: 0, end: 1 })
      }
      parts.push({ type: 'file', path, content: path, start: 0, end: path.length })
      parts.push({ type: 'text', content: ' ', start: 0, end: 1 })
      setPromptExternal(parts, true)
      editorRef.current?.focus()
    },
    [setPromptExternal],
  )

  /** 外部引用（预览面板选中文本）：在 prompt 末尾追加 snippet pill（显示位置标签），
   * snippet 内容隐藏在 pill data 属性中，提交时由 promptToMessageText 展开为代码块。 */
  const appendSnippetReference = useCallback(
    (path: string, lineStart: number, lineEnd: number, snippet: string) => {
      const prompt = promptRef.current
      const parts: Prompt = []
      for (const part of prompt) {
        if (part.type === 'text') parts.push({ ...part })
        else if (part.type === 'file') parts.push({ ...part })
        else if (part.type === 'snippet') parts.push({ ...part })
      }
      const text = promptToText(prompt)
      const label = snippetLabel(path, lineStart, lineEnd)
      if (text.length > 0 && !text.endsWith(' ')) {
        parts.push({ type: 'text', content: ' ', start: 0, end: 1 })
      }
      parts.push({
        type: 'snippet',
        path,
        lineStart,
        lineEnd,
        label,
        snippet,
        start: 0,
        end: label.length,
      })
      parts.push({ type: 'text', content: ' ', start: 0, end: 1 })
      setPromptExternal(parts, true)
      editorRef.current?.focus()
    },
    [setPromptExternal],
  )

  /** 外部引用（终端 Add to Chat）：在 prompt 末尾追加 terminal pill。 */
  const appendTerminalReference = useCallback(
    (label: string, content: string) => {
      const prompt = promptRef.current
      const parts: Prompt = []
      for (const part of prompt) {
        if (part.type === 'text') parts.push({ ...part })
        else if (part.type === 'file') parts.push({ ...part })
        else if (part.type === 'snippet') parts.push({ ...part })
        else if (part.type === 'terminal') parts.push({ ...part })
      }
      const text = promptToText(prompt)
      if (text.length > 0 && !text.endsWith(' ')) {
        parts.push({ type: 'text', content: ' ', start: 0, end: 1 })
      }
      parts.push({ type: 'terminal', label, content, start: 0, end: label.length })
      parts.push({ type: 'text', content: ' ', start: 0, end: 1 })
      setPromptExternal(parts, true)
      editorRef.current?.focus()
    },
    [setPromptExternal],
  )

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    // 图片粘贴优先
    const items = e.clipboardData.items
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) {
          const reader = new FileReader()
          reader.onload = () => {
            const dataUrl = reader.result as string
            const commaIdx = dataUrl.indexOf(',')
            setImages((prev) => [
              ...prev,
              { type: 'image', mediaType: file.type, data: dataUrl.slice(commaIdx + 1) },
            ])
          }
          reader.readAsDataURL(file)
        }
        return
      }
    }
    // 文本粘贴
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    e.preventDefault()
    const normalized = normalizePaste(text)
    if (pasteMode(text) === 'manual' && (text.length >= 8000 || text.split('\n').length >= 120)) {
      setShowPasteConfirm({ text: normalized })
      return
    }
    document.execCommand('insertText', false, normalized)
  }, [])

  const confirmPaste = useCallback(() => {
    if (showPasteConfirm) document.execCommand('insertText', false, showPasteConfirm.text)
    setShowPasteConfirm(null)
  }, [showPasteConfirm])

  const cancelPaste = useCallback(() => setShowPasteConfirm(null), [])

  // 添加图片（拖拽/选择）
  const addImage = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const commaIdx = dataUrl.indexOf(',')
      setImages((prev) => [
        ...prev,
        { type: 'image', mediaType: file.type, data: dataUrl.slice(commaIdx + 1) },
      ])
    }
    reader.readAsDataURL(file)
  }, [])

  const removeImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx))
  }, [])

  const send = useCallback(() => {
    // 流式态：发送键变终止键
    if (isStreaming) {
      onAbort?.()
      return
    }
    const prompt = readPrompt()
    if (isPromptEmpty(prompt) && images.length === 0) return
    const text = promptToMessageText(prompt)
    const files = prompt.flatMap((p) => (p.type === 'file' ? [p.path] : []))
    onSend({ text, files, images })
    if (text.trim()) saveHistory(prependHistoryEntry(loadHistory(), text))
    setImages([])
    setPromptExternal(DEFAULT_PROMPT)
    resetHistory()
  }, [isStreaming, onAbort, onSend, readPrompt, images, setPromptExternal, resetHistory])

  // 追加指令：流式态下注入 steering 文本（仅流式态可用，空文本 no-op）
  const steer = useCallback(() => {
    const prompt = readPrompt()
    if (isPromptEmpty(prompt)) return
    const text = promptToMessageText(prompt)
    onSteer?.(text)
    setPromptExternal(DEFAULT_PROMPT)
    resetHistory()
  }, [readPrompt, onSteer, setPromptExternal, resetHistory])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // IME 组合中不拦截
      if (composingRef.current) return
      // Enter 发送/追加（非 shift，popover 未激活）：流式态追加指令，否则发送
      if (e.key === 'Enter' && !e.shiftKey && !popover) {
        e.preventDefault()
        if (isStreaming) steer()
        else send()
        return
      }
      if (e.key === 'Escape' && popover) {
        setPopover(null)
        e.preventDefault()
        return
      }
      // 历史回溯（popover 未激活时）
      if (!popover && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && editorRef.current) {
        const text = promptToText(promptRef.current)
        const cursor = currentCursor(editorRef.current)
        const inHistory = indexRef.current !== -1
        const canNav = canNavigateHistoryAtCursor(
          e.key === 'ArrowUp' ? 'up' : 'down',
          text,
          cursor,
          inHistory,
        )
        if (canNav) {
          e.preventDefault()
          if (indexRef.current === -1) draftRef.current = text
          const result = navigatePromptHistory({
            entries: loadHistory(),
            currentIndex: indexRef.current,
            direction: e.key === 'ArrowUp' ? 'up' : 'down',
            draft: draftRef.current,
          })
          if (result && 'entry' in result) {
            indexRef.current = result.index
            setPromptExternal(textPrompt(result.entry))
          } else if (result && 'reset' in result) {
            indexRef.current = -1
            setPromptExternal(textPrompt(draftRef.current))
          }
        }
      }
    },
    [popover, send, steer, setPromptExternal, isStreaming],
  )

  return {
    editorRef,
    composingRef,
    promptRef,
    setPromptExternal,
    images,
    popover,
    popoverQuery,
    showPasteConfirm,
    handleInput,
    handleKeyDown,
    handlePaste,
    confirmPaste,
    cancelPaste,
    addImage,
    removeImage,
    insertSlash,
    insertWorkflow,
    insertFile,
    appendFileReference,
    appendSnippetReference,
    appendTerminalReference,
    send,
    steer,
    setPopover,
    isEmpty,
  }
}

export type { PopoverState }
export { useComposer }
