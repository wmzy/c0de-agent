import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { currentCursor, parseFromDOM, reconcile } from './editor-sync.js'
import {
  canNavigateHistoryAtCursor,
  loadHistory,
  navigatePromptHistory,
  prependHistoryEntry,
  saveHistory,
} from './history.js'
import { normalizePaste, pasteMode } from './paste.js'
import type { ImagePart, Prompt } from './types.js'
import { DEFAULT_PROMPT, isPromptEmpty, promptToText } from './types.js'

type PopoverState = 'slash' | 'at' | null

type UseComposerOptions = {
  onSend: (payload: { text: string; files: string[]; images: ImagePart[] }) => void
  onAbort?: () => void
  isStreaming: boolean
  steerMode?: boolean
  hasHistory: boolean
}

/** 把一段纯文本包成单 TextPart 的 Prompt（start/end 仅占位，renderPrompt 不读它们）。 */
function textPrompt(text: string): Prompt {
  return [{ type: 'text', content: text, start: 0, end: text.length }]
}

function useComposer({
  onSend,
  onAbort,
  isStreaming,
  steerMode,
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
    if (slashMatch && !steerMode) {
      setPopover('slash')
      setPopoverQuery(slashMatch[1] ?? '')
    } else if (atMatch && !steerMode) {
      setPopover('at')
      setPopoverQuery(atMatch[1] ?? '')
    } else if (popover) {
      setPopover(null)
      setPopoverQuery('')
    }
  }, [steerMode, popover, resetHistory])

  const setPromptExternal = useCallback((prompt: Prompt) => {
    if (!editorRef.current) return
    mirrorRef.current.input = true
    const cursor = currentCursor(editorRef.current)
    reconcile(editorRef.current, prompt, prompt === DEFAULT_PROMPT ? 0 : cursor)
    promptRef.current = prompt
    setIsEmpty(isPromptEmpty(prompt))
  }, [])

  // popover 选中插入命令（替换整行 /xxx）
  const insertSlash = useCallback(
    (name: string) => {
      setPromptExternal(textPrompt(`/${name} `))
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
    // 流式态：发送键变停止键
    if (isStreaming && !steerMode) {
      onAbort?.()
      return
    }
    const prompt = readPrompt()
    if (isPromptEmpty(prompt) && images.length === 0) return
    const text = promptToText(prompt)
    const files = prompt.flatMap((p) => (p.type === 'file' ? [p.path] : []))
    onSend({ text, files, images })
    if (text.trim()) saveHistory(prependHistoryEntry(loadHistory(), text))
    setImages([])
    setPromptExternal(DEFAULT_PROMPT)
    resetHistory()
  }, [isStreaming, steerMode, onAbort, onSend, readPrompt, images, setPromptExternal, resetHistory])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // IME 组合中不拦截
      if (composingRef.current) return
      // Enter 发送（非 shift，popover 未激活）
      if (e.key === 'Enter' && !e.shiftKey && !popover) {
        e.preventDefault()
        send()
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
    [popover, send, setPromptExternal],
  )

  return {
    editorRef,
    composingRef,
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
    insertFile,
    send,
    setPopover,
    isEmpty,
  }
}

export type { PopoverState }
export { useComposer }
