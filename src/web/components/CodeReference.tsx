import { css } from '@linaria/core'
import { useMatched } from '@native-router/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { CodeBlock } from '@/components/CodeBlock.js'
import { fileAPI } from '@/services/file.js'
import { parseCodeReference } from '@/utils/format.js'

const chip = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 2px 0;
  padding: 2px 8px;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  font-size: 12px;
  background: var(--haze-color-bg-subtle);
  cursor: pointer;
  font-family: var(--haze-font-mono, monospace);
`
const expanded = css`
  margin: 8px 0;
  border-left: 3px solid var(--haze-color-primary);
`
const err = css`
  color: var(--haze-color-text-secondary);
  font-size: 12px;
`
const retryBtn = css`
  margin-left: 6px;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: none;
  color: var(--haze-color-primary);
  font-size: 12px;
  cursor: pointer;
  padding: 1px 6px;
`

/** 失败原因取服务端 message（APIError）或 Error.message，与设置页其余面板同口径。 */
function messageOf(e: unknown): string {
  return (e as { message?: string } | null)?.message ?? (e instanceof Error ? e.message : String(e))
}

/** 渲染代码引用 @[path:start-end]（spec §10.4）。点击展开查看文件对应行区间的代码。 */
export function CodeReference({ token }: { token: string }) {
  const ref = parseCodeReference(token)
  const [open, setOpen] = useState(false)
  // 引用里的路径是**项目内**相对路径，必须以路由里的 projectId 为根去读。不带时
  // 服务端把根落到自己的启动目录（ctx.cwd，见 routes/files.ts），于是展开出来的
  // 是**另一个目录下同名文件**的内容——引用 `src/a.ts:1-5` 却显示服务端进程自己在
  // 哪跑的 a.ts，用户看到的是与消息无关的代码（同名的另一个文件）。文件预览
  // （FilePreview）与文件树都带 projectId，只有这里分叉。
  const matched = useMatched()
  const projectId = matched?.params.projectId
  // Hooks 必须在所有提前返回之前调用：始终调用 useQuery，用 key + enabled 控制。
  // 非 file 引用时用占位 key 且禁用，不会发出请求。
  const filePath = ref?._tag === 'file' ? ref.path : '__no_file__'
  const q = useQuery({
    queryKey: ['file', filePath, projectId],
    queryFn: () => fileAPI.read(filePath, projectId),
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
          {/* 失败必须说清原因并留重试入口：此前只有一句固定的「读取失败」，
              用户无从判断是路径写错、文件已删还是服务端读不动，只能重开整页。 */}
          {q.error ? (
            <span className={err} role="alert" data-testid="code-ref-error">
              读取失败：{messageOf(q.error)}
              <button
                type="button"
                className={retryBtn}
                onClick={() => void q.refetch()}
                data-testid="code-ref-retry"
              >
                重试
              </button>
            </span>
          ) : null}
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
