import { EditorView } from '@codemirror/view'
import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { Button } from 'haze-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CodeEditor } from '@/components/CodeEditor.js'
import { Dialog } from '@/components/Dialog.js'
import { Markdown } from '@/components/Markdown.js'
import { type LineRange, useFileSelection } from '@/contexts/FileSelectionContext.js'
import { useFileReference } from '@/contexts/ReferenceContext.js'
import { getAuthToken } from '@/services/api.js'
import { encodeFilePath, fileAPI } from '@/services/file.js'
import { btnDanger } from '@/styles/tokens.js'

const wrap = css`
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
`

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 12px;
  flex-shrink: 0;
`

const pathText = css`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--haze-color-text-secondary);
`

const closeBtn = css`
  background: transparent;
  border: none;
  color: var(--haze-color-text-secondary);
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
  flex-shrink: 0;

  &:hover {
    color: var(--haze-color-text);
  }
`

const contentScroll = css`
  flex: 1;
  overflow: auto;
  min-height: 0;
  min-width: 0;
  position: relative;
`

const quoteBtn = css`
  position: absolute;
  z-index: 10;
  transform: translate(-50%, -100%);
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  box-shadow: var(--haze-shadow-md);
  white-space: nowrap;
  color: var(--haze-color-text);
  &:hover {
    color: var(--haze-color-primary);
    border-color: var(--haze-color-primary);
  }
`

const mediaImg = css`
  max-width: 100%;
`

const embedFill = css`
  width: 100%;
  height: 100%;
`

const audioFull = css`
  width: 100%;
`

const loadingWrap = css`
  padding: 12px;
`

/** 读失败态：与 RecycleBin/KanbanView 的读失败三段式同口径（标题 + 后端 message + 重试）。 */
const errorWrap = css`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
`

const errorTitle = css`
  color: var(--haze-color-danger);
  font-size: 13px;
  font-weight: 600;
`

const errorDetail = css`
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  /* 后端 message 常含长路径，窄面板下必须能断行而不是撑出横向滚动 */
  overflow-wrap: anywhere;
`

const retryBtn = css`
  padding: 4px 12px;
  font-size: 12px;
`

const hidden = css`
  display: none;
`

const discardActions = css`
  display: flex;
  gap: 8px;
  justify-content: flex-end;
`

const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'flac']
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv']

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

/** 计算选区在文件中的行范围（1-indexed）。
 * 优先用 CodeMirror 的文档坐标（posAtDOM → doc.lineAt）：`.cm-line` 只是**视口内**
 * 渲染出的行（其余行由 .cm-gap 占位，见 CodeMirror 的 computeBlockGapDeco），
 * DOM 下标 ≠ 文档行号——编辑器滚到文件中段时下标恒从 1 起算，选中第 915 行引用出的
 * 却是 1-2 行（LLM 拿到错误位置、点击引用跳转到错误行）。
 * 回退到全文查找选中文本首次出现位置后按换行计数（非 CM 渲染的内容）。 */
export function computeLineRange(
  container: HTMLElement,
  range: Range,
  fullContent: string,
  selText: string,
): { start: number; end: number } {
  const precise = cmLineRange(container, range)
  if (precise) return precise
  if (fullContent && selText) {
    const idx = fullContent.indexOf(selText)
    if (idx >= 0) {
      const start = fullContent.slice(0, idx).split('\n').length
      const end = start + selText.split('\n').length - 1
      return { start, end }
    }
  }
  return { start: 1, end: 1 }
}

/** 选区在 CodeMirror 文档坐标下的行范围；选区不在 CM 编辑器内时返回 null。 */
function cmLineRange(container: HTMLElement, range: Range): { start: number; end: number } | null {
  const lineElOf = (node: Node | undefined | null): HTMLElement | null => {
    if (!node) return null
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
    return el?.closest('.cm-line') ?? null
  }
  const startEl = lineElOf(range.startContainer)
  if (!startEl || !container.contains(startEl)) return null
  const view = EditorView.findFromDOM(startEl)
  if (!view) return null
  try {
    const doc = view.state.doc
    const startPos = view.posAtDOM(range.startContainer, range.startOffset)
    // 选区终点不在同一编辑器内（跨出编辑器的选择）→ 退化为单行范围
    const endEl = lineElOf(range.endContainer)
    const endPos =
      endEl && EditorView.findFromDOM(endEl) === view
        ? view.posAtDOM(range.endContainer, range.endOffset)
        : startPos
    const a = doc.lineAt(startPos).number
    const b = doc.lineAt(endPos).number
    return a <= b ? { start: a, end: b } : { start: b, end: a }
  } catch {
    // 节点已脱离文档（渲染窗口变化等）：交回全文查找兜底
    return null
  }
}

export function FilePreview({ projectId, path }: { projectId: string; path: string }) {
  const { closeFile, openFile, revealRange, registerGuard } = useFileSelection()
  const fileRef = useFileReference()
  // 编辑器脏状态（CodeEditor 上报）：关闭预览 / 切换预览目标前都需确认丢弃。
  // 切换是父组件发起（点文件树、点 tool 里的路径、点 snippet pill），所以还必须
  // 把脏状态注册成否决钩子交给父组件——否则父组件换掉 path 后旧编辑器直接卸载，
  // 未保存的修改连同撤销历史一起静默丢失。
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  // 待确认的丢弃目标：close（✕ 关闭）或 switch（父组件要切到另一个文件）
  const [pendingDiscard, setPendingDiscard] = useState<
    { kind: 'close' } | { kind: 'switch'; path: string; range?: LineRange } | null
  >(null)
  // ref 持有最新 API，避免条件绑定 onMouseUp 导致首次操作失败
  const apiRef = useRef(fileRef)
  apiRef.current = fileRef
  const contentRef = useRef<HTMLDivElement>(null)
  // 按钮始终存在于 DOM 中（display:none 隐藏），通过 ref 直接操作 style 定位/显隐。
  // 不用 useState：选区检测期间任何 React 重渲染都会打断浏览器的选区固化，导致闪烁/丢失。
  const quoteBtnRef = useRef<HTMLButtonElement>(null)
  const selectedTextRef = useRef('')
  const selectedRangeRef = useRef<{ start: number; end: number }>({ start: 1, end: 1 })

  const ext = extOf(path)
  const isMedia =
    IMG_EXT.includes(ext) || AUDIO_EXT.includes(ext) || VIDEO_EXT.includes(ext) || ext === 'pdf'

  // P1 媒体预览：img/audio/video/embed 无法携带 Authorization 头，
  // 经 ?token= query 认证（服务端仅对 /api/files/*/raw 白名单路径接受）。
  const projectQuery = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  const token = getAuthToken()
  const mediaQuery = `${projectQuery}${token ? `${projectQuery ? '&' : '?'}token=${encodeURIComponent(token)}` : ''}`

  const q = useQuery({
    queryKey: ['file', path, projectId],
    queryFn: () => fileAPI.read(path, projectId),
    enabled: !isMedia,
  })
  // 全文内容 ref（供选区行号回退计算），渲染时同步
  const fullContentRef = useRef('')
  fullContentRef.current = q.data?.content ?? ''

  // 渲染内容区（不含 header）
  let body: React.ReactNode
  if (isMedia) {
    if (IMG_EXT.includes(ext)) {
      body = (
        <img
          src={`/api/files/${encodeFilePath(path)}/raw${mediaQuery}`}
          alt={path}
          className={mediaImg}
        />
      )
    } else if (ext === 'pdf') {
      body = (
        <embed
          src={`/api/files/${encodeFilePath(path)}/raw${mediaQuery}`}
          type="application/pdf"
          className={embedFill}
          data-testid="pdf-preview"
        />
      )
    } else if (AUDIO_EXT.includes(ext)) {
      body = (
        <audio
          controls
          src={`/api/files/${encodeFilePath(path)}/raw${mediaQuery}`}
          className={audioFull}
          data-testid="audio-preview"
        >
          <track kind="captions" />
        </audio>
      )
    } else {
      body = (
        <video
          controls
          src={`/api/files/${encodeFilePath(path)}/raw${mediaQuery}`}
          className={mediaImg}
          data-testid="video-preview"
        >
          <track kind="captions" />
        </video>
      )
    }
  } else if (q.isLoading) {
    body = <div className={loadingWrap}>加载中…</div>
  } else if (q.isError) {
    // 「读不到」必须与「真的为空」分开：useQuery 重试耗尽后 data 仍是 undefined，
    // 此前 404/403/500/断网 全部落到下面的「无内容」——header 仍显示路径，看起来
    // 就像文件被清空，用户会据此重写文件或放弃排查（与 RecycleBin/KanbanView 的
    // 读失败态同口径）。APIError 是结构体而非 Error 子类，必须结构化取 message。
    const message =
      (q.error as { message?: string } | null)?.message ??
      (q.error instanceof Error ? q.error.message : null)
    body = (
      <div className={errorWrap} data-testid="file-preview-error" role="alert">
        <span className={errorTitle}>文件读取失败</span>
        <span className={errorDetail}>{message ?? '无法读取该文件内容。'}</span>
        <button
          type="button"
          className={retryBtn}
          onClick={() => void q.refetch()}
          data-testid="file-preview-retry"
        >
          重试
        </button>
      </div>
    )
  } else if (!q.data) {
    body = <div className={loadingWrap}>无内容</div>
  } else if (['md', 'markdown'].includes(ext)) {
    body = <Markdown content={q.data.content} />
  } else {
    // 所有非 markdown 文本/代码文件统一用 CodeEditor：行号 + 行范围高亮。
    body = (
      <CodeEditor
        projectId={projectId}
        path={path}
        initial={q.data.content}
        highlightRange={revealRange ?? null}
        onDirtyChange={setDirty}
      />
    )
  }

  // 选中文本检测：直接操作按钮 DOM（display/left/top），不触发 React 重渲染。
  // 重渲染会在浏览器固化选区的关键窗口期打断它，导致选区闪烁/丢失。
  const checkSelection = useCallback(() => {
    const btn = quoteBtnRef.current
    if (!btn) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      btn.style.display = 'none'
      selectedTextRef.current = ''
      return
    }
    const text = sel.toString().trim()
    if (!text) {
      btn.style.display = 'none'
      selectedTextRef.current = ''
      return
    }
    const range = sel.getRangeAt(0)
    const container = contentRef.current
    if (!container?.contains(range.commonAncestorContainer)) {
      btn.style.display = 'none'
      selectedTextRef.current = ''
      return
    }
    const rect = range.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    btn.style.left = `${rect.left - containerRect.left + rect.width / 2}px`
    btn.style.top = `${rect.top - containerRect.top}px`
    btn.style.display = 'block'
    selectedTextRef.current = text
    selectedRangeRef.current = computeLineRange(container, range, fullContentRef.current, text)
  }, [])

  const handleQuote = useCallback(() => {
    if (!selectedTextRef.current || !apiRef.current) return
    const { start, end } = selectedRangeRef.current
    apiRef.current.insertSnippetReference(path, start, end, selectedTextRef.current)
    window.getSelection()?.removeAllRanges()
    const btn = quoteBtnRef.current
    if (btn) btn.style.display = 'none'
    selectedTextRef.current = ''
  }, [path])

  // 切换文件时隐藏引用按钮
  // biome-ignore lint/correctness/useExhaustiveDependencies: path 变化即需隐藏按钮
  useEffect(() => {
    const btn = quoteBtnRef.current
    if (btn) btn.style.display = 'none'
    selectedTextRef.current = ''
  }, [path])

  // selectionchange 监听：覆盖 onMouseUp 无法捕获的场景——
  // 键盘选择（Ctrl+A / Shift+方向键）、触摸长按选择，以及鼠标拖选长代码行时
  // mouseup 落在面板可见区域外。
  // 150ms 定时器在拖选期间不断重置，仅在选区稳定后触发一次。
  useEffect(() => {
    if (isMedia) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const onSelectionChange = () => {
      clearTimeout(timer)
      timer = setTimeout(checkSelection, 150)
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [checkSelection, isMedia])

  // 脏编辑态点 ✕ 先弹确认，确认后才丢弃修改并关闭；非脏态直接关闭
  const handleClose = useCallback(() => {
    if (dirty) setPendingDiscard({ kind: 'close' })
    else closeFile()
  }, [dirty, closeFile])

  // 用 ref 读最新 path/openFile/closeFile，使否决钩子只需注册一次。
  const pathRef = useRef(path)
  pathRef.current = path
  const openFileRef = useRef(openFile)
  openFileRef.current = openFile

  // 注册否决钩子：父组件要换预览目标（点文件树/点 tool 里的路径/点 snippet pill 都可能，
  // 删除当前文件也会走 closeFile）时先问这里。脏则拦下并弹确认。
  useEffect(() => {
    registerGuard?.((next) => {
      if (!dirtyRef.current) return true
      // 同一文件只换高亮范围（点 snippet pill 定位行）：没有内容会被丢弃，直接放行
      if (next && next.path === pathRef.current) return true
      setPendingDiscard(
        next ? { kind: 'switch', path: next.path, range: next.range } : { kind: 'close' },
      )
      return false
    })
    return () => registerGuard?.(null)
  }, [registerGuard])

  // 用户确认丢弃：先同步清掉脏标记，再重放被拦下的那次变更——否则重放时钩子又读到
  // dirty=true，那次变更会被自己再拦一遍，确认键看起来毫无作用。
  const handleDiscard = useCallback(() => {
    const pending = pendingDiscard
    setPendingDiscard(null)
    if (!pending) return
    dirtyRef.current = false
    setDirty(false)
    if (pending.kind === 'close') closeFile()
    else openFile(pending.path, pending.range)
  }, [pendingDiscard, closeFile, openFile])

  return (
    <div className={wrap}>
      <header className={header}>
        <span className={pathText} data-testid="preview-path">
          {path}
        </span>
        <button type="button" className={closeBtn} onClick={handleClose} aria-label="关闭预览">
          ✕
        </button>
      </header>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 预览内容区需捕获 mouseup 检测选区 */}
      <div
        className={contentScroll}
        data-testid="preview-content"
        ref={contentRef}
        onMouseUp={isMedia ? undefined : checkSelection}
        onScroll={() => {
          const btn = quoteBtnRef.current
          if (btn) btn.style.display = 'none'
        }}
      >
        {body}
        <button
          type="button"
          className={`${quoteBtn} ${hidden}`}
          ref={quoteBtnRef}
          data-testid="quote-selection"
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleQuote}
        >
          引用到对话
        </button>
      </div>
      <Dialog
        open={pendingDiscard !== null}
        onClose={() => setPendingDiscard(null)}
        title="放弃未保存的修改？"
        width="min(380px, 92vw)"
        testId="discard-dialog"
        footer={
          <div className={discardActions}>
            <Button
              data-testid="discard-cancel"
              variant="outline"
              onClick={() => setPendingDiscard(null)}
            >
              取消
            </Button>
            <Button
              data-testid="discard-confirm"
              onClick={handleDiscard}
              className={btnDanger}
              variant="outline"
            >
              放弃修改
            </Button>
          </div>
        }
      >
        <div>
          {pendingDiscard?.kind === 'switch'
            ? `「${path}」有未保存的修改，切换到「${pendingDiscard.path}」将丢弃这些修改。`
            : `「${path}」有未保存的修改，关闭预览将丢弃这些修改。`}
        </div>
      </Dialog>
    </div>
  )
}
