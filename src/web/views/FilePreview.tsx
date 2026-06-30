import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { CodeBlock } from '../components/CodeBlock.js'
import { CodeEditor } from '../components/CodeEditor.js'
import { Markdown } from '../components/Markdown.js'
import { fileAPI } from '../services/file.js'

const wrap = css`
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
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
  const ext = extOf(path)
  const isMedia =
    IMG_EXT.includes(ext) || AUDIO_EXT.includes(ext) || VIDEO_EXT.includes(ext) || ext === 'pdf'

  const q = useQuery({
    queryKey: ['file', path],
    queryFn: () => fileAPI.read(path),
    enabled: !isMedia,
  })

  // 媒体文件直接渲染，不经过 JSON 查询
  if (isMedia) {
    if (IMG_EXT.includes(ext)) {
      return (
        <img src={`/api/files/${encodeURI(path)}/raw`} alt={path} style={{ maxWidth: '100%' }} />
      )
    }
    if (ext === 'pdf') {
      return (
        <embed
          src={`/api/files/${encodeURI(path)}/raw`}
          type="application/pdf"
          style={{ width: '100%', height: '100%' }}
          data-testid="pdf-preview"
        />
      )
    }
    if (AUDIO_EXT.includes(ext)) {
      return (
        <audio
          controls
          src={`/api/files/${encodeURI(path)}/raw`}
          style={{ width: '100%' }}
          data-testid="audio-preview"
        >
          <track kind="captions" />
        </audio>
      )
    }
    if (VIDEO_EXT.includes(ext)) {
      return (
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
  }

  if (q.isLoading) return <div style={{ padding: 12 }}>加载中…</div>
  if (!q.data) return <div style={{ padding: 12 }}>无内容</div>

  if (['md', 'markdown'].includes(ext)) {
    return (
      <div className={wrap}>
        <Markdown content={q.data.content} />
      </div>
    )
  }
  if (CODE_EXT.includes(ext)) {
    return (
      <div className={wrap}>
        <CodeEditor path={path} initial={q.data.content} />
      </div>
    )
  }
  return (
    <div className={wrap}>
      <CodeBlock code={q.data.content} lang={ext} />
    </div>
  )
}
