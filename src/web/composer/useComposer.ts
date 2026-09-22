import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  currentCursor,
  decorateWorkflowz,
  parseFromDOM,
  reconcile,
} from '@/composer/editor-sync.js'
import {
  canNavigateHistoryAtCursor,
  loadHistory,
  navigatePromptHistory,
  prependHistoryEntry,
  saveHistory,
} from '@/composer/history.js'
import { normalizePaste, pasteMode } from '@/composer/paste.js'
import type { ComposerSendPayload, ImagePart, Prompt } from '@/composer/types.js'
import {
  atTokenRange,
  clonePromptParts,
  DEFAULT_PROMPT,
  isPromptEmpty,
  promptToMessageText,
  promptToText,
  replacePromptRange,
  snippetLabel,
} from '@/composer/types.js'
import type { CommandInfo } from '@/hooks/useCommands.js'

type PopoverState = 'slash' | 'subcommand' | 'at' | 'workflow' | null

type UseComposerOptions = {
  onSend: (payload: ComposerSendPayload) => void
  onAbort?: () => void
  /** 流式态下「追加指令」注入 steering 文本（spec §3.9）。 */
  onSteer?: (message: string) => void
  isStreaming: boolean
  hasHistory: boolean
  /** 可用 slash 命令列表（用于检测子命令补全）。 */
  commands?: CommandInfo[]
}

/** 单张图片大小上限（8MB）：base64 进 PGLite + SSE 载荷 + provider 请求，超限拒绝而非
 *  静默失败（P0 审查：此前无任何限制，超大图导致 DB 膨胀/provider 400）。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** 图片数量上限。 */
const MAX_IMAGE_COUNT = 6

/** 校验待添加图片；违规返回错误信息（null=通过）。 */
function validateImage(file: File, currentCount: number): string | null {
  if (currentCount >= MAX_IMAGE_COUNT) {
    return `最多添加 ${MAX_IMAGE_COUNT} 张图片（当前已有 ${currentCount} 张）`
  }
  if (file.size > MAX_IMAGE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1)
    return `图片 ${file.name || '未命名'} 大小 ${mb}MB 超过上限 ${MAX_IMAGE_BYTES / (1024 * 1024)}MB`
  }
  if (file.size === 0) return '图片内容为空'
  return null
}

/** 读取图片文件为 ImagePart（base64 dataURL → 纯 base64）。 */
function readImagePart(file: File): Promise<ImagePart> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const commaIdx = dataUrl.indexOf(',')
      resolve({ type: 'image', mediaType: file.type, data: dataUrl.slice(commaIdx + 1) })
    }
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
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
  commands,
}: UseComposerOptions) {
  const editorRef = useRef<HTMLDivElement>(null)
  const promptRef = useRef<Prompt>(DEFAULT_PROMPT)
  const mirrorRef = useRef({ input: false })
  const composingRef = useRef(false)
  const [images, setImages] = useState<ImagePart[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  /** images 镜像：校验/读取必须在状态更新器之外进行（更新器必须是纯函数——
   *  React 会在 StrictMode 与并发渲染重放中重复调用它，把校验、setImageError、
   *  readImagePart 等副作用写进去会让同一张图被添加两次）。 */
  const imagesRef = useRef<ImagePart[]>([])
  imagesRef.current = images
  const [popover, setPopover] = useState<PopoverState>(null)
  const [popoverQuery, setPopoverQuery] = useState('')
  const [subcommandCmd, setSubcommandCmd] = useState<string | null>(null)
  const [showPasteConfirm, setShowPasteConfirm] = useState<{ text: string } | null>(null)
  const [isEmpty, setIsEmpty] = useState(true)

  // commands 用 ref 避免每次列表变化都重建 handleInput callback
  const commandsRef = useRef<CommandInfo[] | undefined>(commands)
  commandsRef.current = commands

  // commands 异步加载后，重新检测当前文本是否匹配子命令补全。
  // handleInput 在输入时触发，但此时 commands 可能尚未就绪。
  useEffect(() => {
    if (!commands?.length) return
    const text = promptToText(promptRef.current)
    const subMatch = text.match(/^\/(\S+)\s+(\S*)$/)
    if (!subMatch) return
    const cmd = commands.find((c) => c.name === subMatch[1])
    if (!cmd?.subcommands?.length) return
    // 仅在当前未处于 subcommand/workflow popover 时接管
    if (popover === 'subcommand' || popover === 'workflow') return
    setPopover('subcommand')
    setPopoverQuery(subMatch[2] ?? '')
    setSubcommandCmd(subMatch[1] ?? '')
  }, [commands, popover])

  // 历史回溯导航状态
  const indexRef = useRef(-1)
  // 进入历史前的草稿：保存 Prompt 结构而非平铺文本——draft 里若有
  // file/snippet/terminal pill，↓ 退出历史时 textPrompt(平铺文本) 重建会把
  // pill 降级为纯文本（发送时 files 附件丢失）。
  const draftRef = useRef<Prompt | null>(null)
  const resetHistory = useCallback(() => {
    indexRef.current = -1
    draftRef.current = null
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
    // /workflow (run|show|create|edit) <name> — 补全工作流名称
    const workflowMatch = text.match(/^\/workflow\s+(run|show|create|edit)\s+(\S*)$/)
    // /<cmd> <subprefix> — 子命令补全（cmd 必须声明了 subcommands）
    const subMatch = text.match(/^\/(\S+)\s+(\S*)$/)
    const subCmd = subMatch ? commandsRef.current?.find((c) => c.name === subMatch[1]) : undefined
    if (workflowMatch) {
      setPopover('workflow')
      setPopoverQuery(workflowMatch[2] ?? '')
    } else if (subMatch && subCmd?.subcommands?.length) {
      setPopover('subcommand')
      setPopoverQuery(subMatch[2] ?? '')
      setSubcommandCmd(subMatch[1] ?? '')
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

  // popover 选中插入工作流名称（保留 /workflow run/show/create/edit 前缀，仅替换查询部分）
  const insertWorkflow = useCallback(
    (name: string) => {
      const text = promptToText(promptRef.current)
      const match = text.match(/^(\/workflow\s+(?:run|show|create|edit)\s+)\S*$/)
      const prefix = match?.[1] ?? `/workflow run `
      setPromptExternal(textPrompt(`${prefix}${name} `), true)
      setPopover(null)
      editorRef.current?.focus()
    },
    [setPromptExternal],
  )

  // popover 选中插入子命令（替换整行为 /<cmd> <sub> ）
  const insertSubcommand = useCallback(
    (sub: string) => {
      if (!subcommandCmd) return
      setPromptExternal(textPrompt(`/${subcommandCmd} ${sub} `), true)
      setPopover(null)
      setSubcommandCmd(null)
      editorRef.current?.focus()
    },
    [setPromptExternal, subcommandCmd],
  )

  // popover 选中插入文件 pill（替换 @query token）。
  // 此前从 promptToText 平铺文本重建整个 prompt——既有 file/snippet/terminal
  // pill 被降级为纯文本（发送时 files 附件丢失）。改为定位光标前 @token
  // 范围并用 replacePromptRange 原位替换，范围外 part 原样保留。
  const insertFile = useCallback(
    (path: string) => {
      const prompt = promptRef.current
      if (!editorRef.current) return
      const cursor = currentCursor(editorRef.current)
      const range = atTokenRange(promptToText(prompt), cursor)
      if (!range) return
      const pill: Prompt = [{ type: 'file', path, content: path, start: 0, end: path.length }]
      setPromptExternal(replacePromptRange(prompt, range.start, range.end, pill), true)
      setPopover(null)
      editorRef.current.focus()
    },
    [setPromptExternal],
  )

  /** 外部引用（文件树 @ 按钮）：在 prompt 末尾追加 file pill，无需 @ token。
   *  保留全部既有 pill 类型（此前逐类挑选复制，追加文件引用会吞掉
   *  snippet/terminal pill）。 */
  const appendFileReference = useCallback(
    (path: string) => {
      const prompt = promptRef.current
      const parts = clonePromptParts(prompt)
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
   *  snippet 内容隐藏在 pill data 属性中，提交时由 promptToMessageText 展开为代码块。 */
  const appendSnippetReference = useCallback(
    (path: string, lineStart: number, lineEnd: number, snippet: string) => {
      const prompt = promptRef.current
      const parts = clonePromptParts(prompt)
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
      const parts = clonePromptParts(prompt)
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

  /** 外部填入纯文本（空状态示例卡片）：已有草稿时换行追加，并聚焦编辑器。
   *  以 part 追加而非从平铺文本重建——既有 pill 不被降级为文本。 */
  const insertPromptText = useCallback(
    (text: string) => {
      const prompt = promptRef.current
      const current = promptToText(prompt)
      const parts = clonePromptParts(prompt)
      parts.push({
        type: 'text',
        content: current.length > 0 ? `\n${text}` : text,
        start: 0,
        end: text.length,
      })
      setPromptExternal(parts, true)
      editorRef.current?.focus()
    },
    [setPromptExternal],
  )

  /** 校验并读取图片后追加（拖拽/选择/粘贴共用）。
   *  校验与读取都在 setImages 之外完成：更新器内做副作用会在 StrictMode /
   *  并发渲染重放时执行两次（同一张图被添加两次、读取两次）。 */
  const addImageFile = useCallback((file: File) => {
    const err = validateImage(file, imagesRef.current.length)
    setImageError(err)
    if (err) return
    void readImagePart(file)
      .then((part) => setImages((cur) => [...cur, part]))
      .catch(() => setImageError('读取图片失败'))
  }, [])

  // 添加图片（拖拽/选择）
  const addImage = useCallback(
    (file: File) => {
      addImageFile(file)
    },
    [addImageFile],
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      // 图片粘贴优先
      const items = e.clipboardData.items
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const file = item.getAsFile()
          if (!file) return
          addImageFile(file)
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
    },
    [addImageFile],
  )

  const confirmPaste = useCallback(() => {
    if (showPasteConfirm) document.execCommand('insertText', false, showPasteConfirm.text)
    setShowPasteConfirm(null)
  }, [showPasteConfirm])

  const cancelPaste = useCallback(() => setShowPasteConfirm(null), [])

  const removeImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx))
    setImageError(null)
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
    // prompt 结构随载荷传递：@agent 提及提取需要区分「用户输入文本」与
    // snippet/terminal 展开内容（见 extractAgentMentions）。
    onSend({ text, files, images, prompt })
    if (text.trim()) saveHistory(prependHistoryEntry(loadHistory(), text))
    setImages([])
    setImageError(null)
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
          if (indexRef.current === -1) draftRef.current = promptRef.current
          const result = navigatePromptHistory({
            entries: loadHistory(),
            currentIndex: indexRef.current,
            direction: e.key === 'ArrowUp' ? 'up' : 'down',
            draft: promptToText(draftRef.current ?? DEFAULT_PROMPT),
          })
          if (result && 'entry' in result) {
            indexRef.current = result.index
            setPromptExternal(textPrompt(result.entry))
          } else if (result && 'reset' in result) {
            indexRef.current = -1
            setPromptExternal(draftRef.current ?? DEFAULT_PROMPT)
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
    imageError,
    popover,
    popoverQuery,
    subcommandCmd,
    showPasteConfirm,
    handleInput,
    handleKeyDown,
    handlePaste,
    confirmPaste,
    cancelPaste,
    addImage,
    removeImage,
    insertSlash,
    insertSubcommand,
    insertWorkflow,
    insertFile,
    appendFileReference,
    appendSnippetReference,
    appendTerminalReference,
    insertPromptText,
    send,
    steer,
    setPopover,
    isEmpty,
  }
}

export type { PopoverState }
export { useComposer }
