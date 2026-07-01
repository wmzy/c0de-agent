import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { CodeBlock } from '../components/CodeBlock.js'
import { CodeEditor } from '../components/CodeEditor.js'
import { Markdown } from '../components/Markdown.js'
import { useFileSelection } from '../contexts/FileSelectionContext.js'
import { fileAPI } from '../services/file.js'

const wrap = css`
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
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

export function FilePreview({ path }: { path: string }) {
  const { closeFile } = useFileSelection()
  const ext = extOf(path)
  const isMedia =
    IMG_EXT.includes(ext) || AUDIO_EXT.includes(ext) || VIDEO_EXT.includes(ext) || ext === 'pdf'

  const q = useQuery({
    queryKey: ['file', path],
    queryFn: () => fileAPI.read(path),
    enabled: !isMedia,
  })

  // 渲染内容区（不含 header）
  let body: React.ReactNode
  if (isMedia) {
    if (IMG_EXT.includes(ext)) {
      body = (
        <img src={`/api/files/${encodeURI(path)}/raw`} alt={path} style={{ maxWidth: '100%' }} />
      )
    } else if (ext === 'pdf') {
      body = (
        <embed
          src={`/api/files/${encodeURI(path)}/raw`}
          type="application/pdf"
          style={{ width: '100%', height: '100%' }}
          data-testid="pdf-preview"
        />
      )
    } else if (AUDIO_EXT.includes(ext)) {
      body = (
        <audio
          controls
          src={`/api/files/${encodeURI(path)}/raw`}
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
          src={`/api/files/${encodeURI(path)}/raw`}
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
    body = <CodeEditor path={path} initial={q.data.content} />
  } else {
    body = <CodeBlock code={q.data.content} lang={ext} />
  }

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
      <div className={contentScroll}>{body}</div>
    </div>
  )
}
