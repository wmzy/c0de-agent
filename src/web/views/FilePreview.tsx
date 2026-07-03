import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
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

export function FilePreview({ projectId, path }: { projectId: string; path: string }) {
  const { closeFile } = useFileSelection()
  const fileRef = useFileReference()
  // ref 持有最新 API，避免条件绑定 onMouseUp 导致首次操作失败
  const apiRef = useRef(fileRef)
  apiRef.current = fileRef
  const contentRef = useRef<HTMLDivElement>(null)
  const [quotePos, setQuotePos] = useState<{ x: number; y: number; text: string } | null>(null)

  const ext = extOf(path)
  const isMedia =
    IMG_EXT.includes(ext) || AUDIO_EXT.includes(ext) || VIDEO_EXT.includes(ext) || ext === 'pdf'

  const projectQuery = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''

  const q = useQuery({
    queryKey: ['file', path, projectId],
    queryFn: () => fileAPI.read(path, projectId),
    enabled: !isMedia,
  })

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
    body = <CodeEditor projectId={projectId} path={path} initial={q.data.content} />
  } else {
    body = <CodeBlock code={q.data.content} lang={ext} />
  }

  // 选中文本检测：mouseup 后检查 selection 是否在内容区内且非空
  const checkSelection = useCallback(() => {
    if (!apiRef.current) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setQuotePos(null)
      return
    }
    const text = sel.toString().trim()
    if (!text) {
      setQuotePos(null)
      return
    }
    const range = sel.getRangeAt(0)
    const container = contentRef.current
    if (!container?.contains(range.commonAncestorContainer)) {
      setQuotePos(null)
      return
    }
    const rect = range.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    setQuotePos({
      x: rect.left - containerRect.left + rect.width / 2,
      y: rect.top - containerRect.top,
      text,
    })
  }, [])

  const handleQuote = useCallback(() => {
    if (!quotePos || !apiRef.current) return
    apiRef.current.insertTextReference(path, quotePos.text)
    window.getSelection()?.removeAllRanges()
    setQuotePos(null)
  }, [quotePos, path])

  // 切换文件时清除引用按钮；path 是 prop 变化时唯一需响应的依赖
  // biome-ignore lint/correctness/useExhaustiveDependencies: path 变化即需重置 quotePos
  useEffect(() => {
    setQuotePos(null)
  }, [path])

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
        onScroll={() => setQuotePos(null)}
      >
        {body}
        {quotePos && (
          <button
            type="button"
            className={quoteBtn}
            data-testid="quote-selection"
            style={{ left: quotePos.x, top: quotePos.y }}
            onClick={handleQuote}
          >
            引用到对话
          </button>
        )}
      </div>
    </div>
  )
}
