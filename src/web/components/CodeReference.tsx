import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { fileAPI } from '../services/file.js'
import { parseCodeReference } from '../utils/format.js'
import { CodeBlock } from './CodeBlock.js'

const chip = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 2px 0;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 12px;
  background: var(--bg-secondary);
  cursor: pointer;
  font-family: var(--font-mono, monospace);
`
const expanded = css`
  margin: 8px 0;
  border-left: 3px solid var(--primary);
`
const err = css`
  color: var(--text-secondary);
  font-size: 12px;
`

/** 渲染代码引用 @[path:start-end]（spec §10.4）。点击展开查看文件对应行区间的代码。 */
export function CodeReference({ token }: { token: string }) {
  const ref = parseCodeReference(token)
  const [open, setOpen] = useState(false)
  // Hooks 必须在所有提前返回之前调用：始终调用 useQuery，用 key + enabled 控制。
  // 非 file 引用时用占位 key 且禁用，不会发出请求。
  const filePath = ref?._tag === 'file' ? ref.path : '__no_file__'
  const q = useQuery({
    queryKey: ['file', filePath],
    queryFn: () => fileAPI.read(filePath),
    enabled: open && ref?._tag === 'file',
  })

  if (!ref) return <>{token}</>

  // 消息引用（@[msgId:n]）：MVP 不跨消息取内容，仅显示标签。
  if (ref._tag === 'message') {
    return (
      <span className={chip} data-testid="code-ref-message">
        @[{ref.messageId}:{ref.blockIndex}]
      </span>
    )
  }

  const label = `${ref.path}:${ref.startLine}${ref.endLine !== ref.startLine ? `-${ref.endLine}` : ''}`

  return (
    <div>
      <button
        type="button"
        className={chip}
        data-testid="code-ref-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} {label}
      </button>
      {open && (
        <div className={expanded} data-testid="code-ref-body">
          {q.isLoading && <span className={err}>加载中…</span>}
          {q.error && <span className={err}>读取失败</span>}
          {q.data && (
            <CodeBlock
              code={sliceLines(q.data.content, ref.startLine, ref.endLine)}
              lang={extOf(ref.path)}
            />
          )}
        </div>
      )}
    </div>
  )
}

function extOf(p: string) {
  return p.split('.').pop()?.toLowerCase() ?? ''
}
function sliceLines(src: string, start: number, end: number) {
  const lines = src.split('\n')
  return lines.slice(Math.max(0, start - 1), end).join('\n')
}
