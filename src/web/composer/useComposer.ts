import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { loadDraft, saveDraft } from '@/composer/draft.js'
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
import {
  LARGE_PASTE_BREAKS,
  LARGE_PASTE_CHARS,
  normalizePaste,
  pasteMode,
} from '@/composer/paste.js'
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
  /**
   * 发送回调。返回值可等待：本 hook 据此在**发送失败**时把草稿与图片原样还原到
   * 输入框。此前 onSend 是同步 void、发送即清空，而失败结果（未配 provider、
   * 网关 400、网络中断）只有调用方知道——用户输入的消息连同图片一起凭空消失，
   * 且失败原因渲染在顶栏一行省略号里，触屏根本读不到。
   *
   * 返回值语义：Promise<boolean> / boolean，true/false 表示「消息是否真的送出去了」。
   * 为 true 或返回 void（保持旧契约）时视为成功。
   */
  onSend: (payload: ComposerSendPayload) => boolean | undefined | Promise<boolean | undefined>
  onAbort?: () => void
  /** 流式态下「追加指令」注入 steering 文本（spec §3.9）。
   *  返回值语义同 onSend：不返回值/true 视为已受理，false 或 Promise<false> 表示
   *  没送出去（后端 {steered:false} 或请求失败），调用方据此保留输入。 */
  onSteer?: (message: string) => boolean | undefined | Promise<boolean | undefined>
  isStreaming: boolean
  /**
   * 输入区处于「忙」态：发送/追加都拿不到可执行的目标（草稿页建会话窗口——
   * 既没有 run 可中止，也没有 steering 通道）。此时 send/steer 一律 no-op，
   * 否则回车会再次走 onSend，多建一个空会话；按钮的禁用态由调用方负责。
   */
  busy?: boolean
  hasHistory: boolean
  /** 可用 slash 命令列表（用于检测子命令补全）。 */
  commands?: CommandInfo[]
  /**
   * 草稿持久化作用域（`s:<sessionId>` / `p:<projectId>`）。给定后输入内容按作用域
   * 落 localStorage：切会话（Composer 随 ChatSkeleton 卸载）或刷新页面后原样回填。
   * 缺省不持久化（无归属的输入没有可回填的地方）。
   */
  draftScope?: string
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
  busy = false,
  hasHistory: _hasHistory,
  commands,
  draftScope,
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
  /** 大段粘贴待确认内容：chars/lines 为触发判定时的原始文本规模，供确认条展示。 */
  const [showPasteConfirm, setShowPasteConfirm] = useState<{
    text: string
    chars: number
    lines: number
  } | null>(null)
  const [isEmpty, setIsEmpty] = useState(true)
  /**
   * 发送世代号。每次 send/steer 自增；异步失败还原只在自己那一代仍是最新时回写，
   * 否则会把后续发送刚清空/输入的框内容盖回去（见 send 里的 restore）。
   */
  const sendAttemptRef = useRef(0)

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

  // 草稿持久化作用域镜像：persistDraft 的身份必须稳定（它进了 handleInput /
  // setPromptExternal 的 useCallback 依赖链），不能直接闭包 draftScope。
  const draftScopeRef = useRef(draftScope)
  draftScopeRef.current = draftScope
  /**
   * 还原是否已完成。挂载时先读存储再允许回写——[images] 副作用在挂载首帧就会跑，
   * 那时 imagesRef 还是初始的 []，抢先回写会用空图片覆盖刚读出来的草稿。
   */
  const draftRestoredRef = useRef(false)

  /** 把当前输入与附件落盘（空草稿删除键）。无作用域/尚未还原时 no-op。 */
  const persistDraft = useCallback(() => {
    const scope = draftScopeRef.current
    if (!scope || !draftRestoredRef.current) return
    saveDraft(scope, promptRef.current, imagesRef.current)
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
    persistDraft()
  }, [popover, resetHistory, persistDraft])

  /**
   * 外部写入编辑器。
   *
   * persist=false 只给提示历史回溯用：↑/↓ 换的是「当前看哪一条」，不是「草稿
   * 变成了什么」。落盘会把召回的旧提示写成本会话的草稿，用户那份正在写的
   * 草稿（含 @file/snippet pill 与图片）就此被顶掉——而原草稿只在 draftRef 内存
   * 里，切会话或刷新即永久丢失。回溯期间不动存储，用户按下 ↓ 或直接编辑，
   * handleInput/reset 的落盘自然写入真实内容。
   */
  const setPromptExternal = useCallback(
    (prompt: Prompt, cursorAtEnd = false, persist = true) => {
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
      // 外部写入同样落盘：发送成功后的清空（→ 键删除）、slash/@ 插入、失败还原都要反映到草稿。
      if (persist) persistDraft()
    },
    [persistDraft],
  )

  // 挂载 / 切换作用域：回填该作用域的草稿。无草稿时清空输入区——上一个会话的
  // 文字不能留在下一个会话的输入框里（切会话时 ChatSession 会先渲染 ChatSkeleton，
  // 本 hook 整体重建，草稿只能来自存储）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: setImages 是 useState 的稳定 setter，列进依赖是为了让「还原哪些附件」显式可见
  useEffect(() => {
    draftRestoredRef.current = false
    const stored = draftScope ? loadDraft(draftScope) : null
    setPromptExternal(stored?.prompt ?? DEFAULT_PROMPT, true)
    setImages(stored?.images ?? [])
    setImageError(null)
    resetHistory()
    draftRestoredRef.current = true
  }, [draftScope, setPromptExternal, setImages, resetHistory])

  // 附件变化（添加/移除/还原）也要落盘：它们不经 handleInput/setPromptExternal。
  // 声明在还原 effect 之后——挂载首帧必须先把存储读出来再允许回写。
  // biome-ignore lint/correctness/useExhaustiveDependencies: images 不在回调体里（persistDraft 经 imagesRef 读），但附件变化必须触发这次回写
  useEffect(() => {
    persistDraft()
  }, [images, persistDraft])

  // popover 选中插入命令（替换整行 /xxx）
  // 返回值 = 是否真的写入了编辑器。调用方（Composer 的 Enter 分支）据此决定
  // 能不能把这颗按键算作「确认候选」：插不进去时必须把按键放行，否则 Enter
  // 被一个失效的浮层静默吞掉（消息发不出去、零反馈）。
  const insertSlash = useCallback(
    (name: string) => {
      setPromptExternal(textPrompt(`/${name} `), true)
      setPopover(null)
      editorRef.current?.focus()
      return true
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
      return true
    },
    [setPromptExternal],
  )

  // popover 选中插入子命令（替换整行为 /<cmd> <sub> ）
  const insertSubcommand = useCallback(
    (sub: string) => {
      if (!subcommandCmd) return false
      setPromptExternal(textPrompt(`/${subcommandCmd} ${sub} `), true)
      setPopover(null)
      setSubcommandCmd(null)
      editorRef.current?.focus()
      return true
    },
    [setPromptExternal, subcommandCmd],
  )

  // popover 选中插入文件 pill（替换 @query token）。
  // 此前从 promptToText 平铺文本重建整个 prompt——既有 file/snippet/terminal
  // pill 被降级为纯文本（发送时 files 附件丢失）。改为定位光标前 @token
  // 范围并用 replacePromptRange 原位替换，范围外 part 原样保留。
  // 光标前没有 @token（浮层开着时光标被移走）⇒ 无范围可替换，返回 false。
  const insertFile = useCallback(
    (path: string) => {
      const prompt = promptRef.current
      if (!editorRef.current) return false
      const cursor = currentCursor(editorRef.current)
      const range = atTokenRange(promptToText(prompt), cursor)
      if (!range) return false
      const pill: Prompt = [{ type: 'file', path, content: path, start: 0, end: path.length }]
      setPromptExternal(replacePromptRange(prompt, range.start, range.end, pill), true)
      setPopover(null)
      editorRef.current.focus()
      return true
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

  /**
   * 文本入框的唯一通道：换行归一 + 大段确认 + 插入。
   *
   * 拖放与粘贴此前是两条割裂的实现——handleDrop 里裸调 execCommand，跳过大段
   * 确认与换行归一。`takeFocus` 是拖放路径的显式声明：Chromium 实测会把焦点
   * 交给插入目标，但那是实现细节而非契约；粘贴时事件目标本就是编辑器，显式
   * 抢焦点无意义，故由调用方按路径声明。
   */
  const insertText = useCallback((raw: string, takeFocus: boolean) => {
    if (!raw) return
    const normalized = normalizePaste(raw)
    const chars = raw.length
    const lines = raw.split('\n').length
    if (
      pasteMode(raw) === 'manual' &&
      (chars >= LARGE_PASTE_CHARS || lines >= LARGE_PASTE_BREAKS)
    ) {
      // 大段内容先确认再插入（确认条见 Composer）。调用方已 preventDefault 吞掉
      // 原生插入：此处只置状态而无人渲染确认 UI 时，内容会静默丢失。
      // chars/lines 取自原始文本，与判定同源。
      setShowPasteConfirm({ text: normalized, chars, lines })
      return
    }
    if (takeFocus) editorRef.current?.focus()
    document.execCommand('insertText', false, normalized)
  }, [])

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
      // 文本粘贴（焦点本就在编辑器里，无需抢焦点）
      const text = e.clipboardData.getData('text/plain')
      if (!text) return
      e.preventDefault()
      insertText(text, false)
    },
    [addImageFile, insertText],
  )

  const confirmPaste = useCallback(() => {
    const pending = showPasteConfirm
    setShowPasteConfirm(null)
    if (!pending) return
    // 点击「插入」后焦点在按钮上，execCommand('insertText') 只作用于当前可编辑
    // 焦点元素——不先交还焦点，整段文本会再次静默丢失。
    editorRef.current?.focus()
    document.execCommand('insertText', false, pending.text)
  }, [showPasteConfirm])

  const cancelPaste = useCallback(() => {
    setShowPasteConfirm(null)
    editorRef.current?.focus()
  }, [])

  const removeImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx))
    setImageError(null)
  }, [])

  const send = useCallback(() => {
    // 忙态（首条消息在建会话的窗口）：既没有 run 可中止，也没有第二次发送的
    // 意义——回车再走一次 onSend 会多建一个空会话并丢掉当前输入。按钮已禁用，
    // 这里挡住的是 Enter 键与直接调用。
    if (busy) return
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
    const payload = { text, files, images, prompt }
    // 发送失败要把用户输入原样还回去，先留住快照（send() 是同步的，回调返回的
    // Promise 落地时 prompt/images 可能已被清空）。
    const snapshot = { prompt: clonePromptParts(prompt), images }
    // 提示历史存**用户可见文本**（promptToText：pill 贡献标签），不是提交给后端
    // 的展开形态（promptToMessageText 会把 snippet/terminal pill 展开成代码块）——
    // 否则 ↑ 召回一条带引用的消息会把整段代码块当纯文本灌回输入框，去重比较也在
    // 展开形态上做（同一输入因引用内容不同被当成不同条目）。
    const visible = promptToText(prompt)
    // 还原时要判断「头一条是否本次新加」：直接比 entries[0] === visible 会因
    // prepend 存的是 trim 后的文本而误判（带尾随空格时删掉旧记录）。
    const historyBefore = visible.trim() ? loadHistory() : null
    const outcome = onSend(payload)
    // 本次发送的世代号：还原分支只认自己这一代。请求在途期间用户可能又发了一次
    // （或又按了 steering），那时先落地的那次失败再回来还原，就会把后来那条的输入
    // 一起盖掉、并按错误的假设去动提示历史。
    const attempt = ++sendAttemptRef.current
    // 清空照旧立即发生（发送成功的体感不能等一轮请求）：失败走下面的还原分支。
    if (visible.trim()) saveHistory(prependHistoryEntry(loadHistory(), visible))
    setImages([])
    setImageError(null)
    setPromptExternal(DEFAULT_PROMPT)
    resetHistory()
    // 失败还原：onSend 返回 Promise<false>/false 时把文本、图片、提示历史条目
    // 一并还回，用户改好设置后直接回车即可，不用凭记忆重打。
    const restore = () => {
      // 已被更新的发送取代：本次失败不再回写。
      if (sendAttemptRef.current !== attempt) return
      // 输入框在请求在途期间仍可编辑（ComposerEditor 无只读路径），用户此刻新敲的
      // 内容/新加的图片不属于这条失败消息——无条件覆盖会凭空吞掉它们。只在输入框
      // 仍是发送后清空的状态时才回填。
      const untouched = isPromptEmpty(readPrompt()) && imagesRef.current.length === 0
      if (!untouched) return
      // 光标停在文末：send() 清空时把光标放到 offset 0，沿用它会让还原后的第一
      // 个字前面挂一个光标，用户接着敲的字都插到消息前面。
      setPromptExternal(snapshot.prompt, true)
      setImages(snapshot.images)
      setImageError(null)
      if (visible.trim()) {
        const entries = loadHistory()
        // 头一条相对发送前变了 = 本次新加的 → 撤掉；没变（去重命中旧记录）则保留。
        // 期间若有别的发送插进来（entries[0] 已是别人的），不动历史——那不是本次的条目。
        if (historyBefore && entries[0] !== historyBefore[0] && entries[0] === visible.trim()) {
          saveHistory(entries.slice(1))
        }
      }
      editorRef.current?.focus()
    }
    if (outcome === false) {
      restore()
      return
    }
    if (outcome && typeof (outcome as Promise<boolean | undefined>).then === 'function') {
      void (outcome as Promise<boolean | undefined>).then((ok) => {
        if (ok === false) restore()
      })
    }
  }, [busy, isStreaming, onAbort, onSend, readPrompt, images, setPromptExternal, resetHistory])

  // 追加指令：流式态下注入 steering 文本（仅流式态可用，空文本 no-op）
  const steer = useCallback(() => {
    // 没有注入回调就不清空：steer 的清空语义建立在「这条文字已经被送到在途的
    // run 里」之上，调用方没接 onSteer 时清空等于把用户输入凭空丢掉。
    if (busy || !onSteer) return
    const prompt = readPrompt()
    if (isPromptEmpty(prompt)) return
    const text = promptToMessageText(prompt)
    // steering 同样把输入清空：它取代在途的那次发送，那次失败回来时不得回填。
    // 但「清空」的前提是这条指令真的被受理——POST /api/chat/steer 回
    // {steered:false} 时指令既没进 run 队列也没落库（agent 从未收到，刷新后
    // 乐观条目即消失）。此前无条件清空：用户敲的整段指令连气泡都没有，彻底丢失。
    // 现在只有确认受理才清空，失败时输入原样留着，配合 error 行让用户改用发送。
    sendAttemptRef.current += 1
    const visible = promptToText(prompt)
    const clear = () => {
      // 输入框在请求在途期间仍可编辑：期间用户新敲的字不属于这条指令，不覆盖。
      if (promptToText(readPrompt()) !== visible) return
      setPromptExternal(DEFAULT_PROMPT)
      resetHistory()
    }
    const outcome = onSteer(text)
    if (outcome === false) return
    if (outcome && typeof (outcome as Promise<boolean | undefined>).then === 'function') {
      void (outcome as Promise<boolean | undefined>).then((ok) => {
        if (ok !== false) clear()
      })
    } else {
      // 旧契约：同步 void 回调视为受理，保持「发出即清空」的原有体感。
      clear()
    }
  }, [busy, readPrompt, onSteer, setPromptExternal, resetHistory])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, popoverSuppressed = false) => {
      // IME 组合中不拦截
      if (composingRef.current) return
      // popoverSuppressed：调用方（Composer）已判定当前浮层没有任何候选、且不会渲染出
      // 任何 UI。此时必须按「无浮层」处理按键——否则 popover 状态里挂着一个画不出来的
      // 菜单，Enter 被它静默吞掉：用户输入 `@不对的名字 正文` 或未匹配的 `/cmd` 后回车，
      // 消息永远发不出去，也没有任何反馈（只有 Esc 或鼠标能脱身）。
      const popoverActive = !!popover && !popoverSuppressed
      // Enter 发送/追加（非 shift，popover 未激活）：流式态追加指令，否则发送
      if (e.key === 'Enter' && !e.shiftKey && !popoverActive) {
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
      if (!popoverActive && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && editorRef.current) {
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
            setPromptExternal(textPrompt(result.entry), false, false)
          } else if (result && 'reset' in result) {
            indexRef.current = -1
            // ↓ 退出历史：草稿回到输入框，此时它就是草稿——落盘（回溯期间存储里
            // 一直是原草稿，这里写回同一份内容，语义上仍是「草稿未被顶掉」）。
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
    /** 外部还原草稿时批量写入图片附件（见 Composer 的 restoreDraft）。 */
    setImages,
    images,
    imageError,
    popover,
    popoverQuery,
    subcommandCmd,
    showPasteConfirm,
    handleInput,
    handleKeyDown,
    handlePaste,
    /** 拖放文本入框：焦点未必在编辑器，需抢焦点后再插入（见 insertText）。 */
    insertText,
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
