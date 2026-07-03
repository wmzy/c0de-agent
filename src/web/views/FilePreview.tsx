import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'
import { CodeBlock } from '../components/CodeBlock.js'
import { CodeEditor } from '../components/CodeEditor.js'
import { Markdown } from '../components/Markdown.js'
import { useFileSelection } from '../contexts/FileSelectionContext.js'
import { useFileReference } from '../contexts/ReferenceContext.js'
import { fileAPI } from '../services/file.js'

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
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  flex-shrink: 0;
`

const pathText = css`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
`

const closeBtn = css`
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
  flex-shrink: 0;

  &:hover {
    color: var(--text);
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
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  box-shadow: var(--shadow);
  white-space: nowrap;
  color: var(--text);
  &:hover {
    color: var(--primary);
    border-color: var(--primary);
  }
`

const CODE_EXT = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'css',
  'html',
  'sh',
  'sql',
]
const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'flac']
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv']

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

/** 计算选区在文件中的行范围（1-indexed）。
 * 优先用 CodeMirror 的 .cm-line 元素精确计数；回退到全文查找选中文本首次出现位置后按换行计数。 */
function computeLineRange(
  container: HTMLElement,
  range: Range,
  fullContent: string,
  selText: string,
): { start: number; end: number } {
  const lines = container.querySelectorAll('.cm-line')
  if (lines.length > 0) {
    let startLine = -1
    let endLine = -1
    lines.forEach((line, i) => {
      const n = i + 1
      if (startLine === -1 && line.contains(range.startContainer)) startLine = n
      if (line.contains(range.endContainer)) endLine = n
    })
    if (startLine !== -1 && endLine !== -1) {
      if (endLine < startLine) [startLine, endLine] = [endLine, startLine]
      return { start: startLine, end: endLine }
    }
  }
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

export function FilePreview({ projectId, path }: { projectId: string; path: string }) {
  const { closeFile, revealLine } = useFileSelection()
  const fileRef = useFileReference()
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

  const projectQuery = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''

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
          src={`/api/files/${encodeURI(path)}/raw${projectQuery}`}
          alt={path}
          style={{ maxWidth: '100%' }}
        />
      )
    } else if (ext === 'pdf') {
      body = (
        <embed
          src={`/api/files/${encodeURI(path)}/raw${projectQuery}`}
          type="application/pdf"
          style={{ width: '100%', height: '100%' }}
          data-testid="pdf-preview"
        />
      )
    } else if (AUDIO_EXT.includes(ext)) {
      body = (
        <audio
          controls
          src={`/api/files/${encodeURI(path)}/raw${projectQuery}`}
          style={{ width: '100%' }}
          data-testid="audio-preview"
        >
          <track kind="captions" />
        </audio>
      )
    } else {
      body = (
        <video
          controls
          src={`/api/files/${encodeURI(path)}/raw${projectQuery}`}
          style={{ maxWidth: '100%' }}
          data-testid="video-preview"
        >
          <track kind="captions" />
        </video>
      )
    }
  } else if (q.isLoading) {
    body = <div style={{ padding: 12 }}>加载中…</div>
  } else if (!q.data) {
    body = <div style={{ padding: 12 }}>无内容</div>
  } else if (['md', 'markdown'].includes(ext)) {
    body = <Markdown content={q.data.content} />
  } else if (CODE_EXT.includes(ext)) {
    body = (
      <CodeEditor
        projectId={projectId}
        path={path}
        initial={q.data.content}
        gotoLine={revealLine ?? null}
      />
    )
  } else {
    body = <CodeBlock code={q.data.content} lang={ext} />
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

  return (
    <div className={wrap}>
      <header className={header}>
        <span className={pathText} data-testid="preview-path">
          {path}
        </span>
        <button type="button" className={closeBtn} onClick={closeFile} aria-label="关闭预览">
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
          className={quoteBtn}
          ref={quoteBtnRef}
          data-testid="quote-selection"
          style={{ display: 'none' }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleQuote}
        >
          引用到对话
        </button>
      </div>
    </div>
  )
}
