import { css } from '@linaria/core'
import { useMatched } from '@native-router/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { CodeBlock } from '@/components/CodeBlock.js'
import { Collapsible } from '@/components/Collapsible.js'
import { LoadErrorNotice } from '@/components/LoadErrorNotice.js'
import { fileQueryOptions } from '@/services/file.js'
import { messageOf } from '@/utils/errors.js'
import { extOf, parseCodeReference } from '@/utils/format.js'

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
    ...fileQueryOptions(filePath, projectId),
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
      {/* 展开骨架收敛在 Collapsible（受控：open 同时控制 useQuery 的 enabled，
          只有点开后才发读文件请求）；失败占位收敛在 LoadErrorNotice（secondary
          色调，不再自持第三套「原因 + 重试」样式）。 */}
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        header={label}
        headerClassName={chip}
        testId="code-ref-toggle"
        bodyClassName={expanded}
        bodyTestId="code-ref-body"
      >
        {q.isLoading && <span className={err}>加载中…</span>}
        {/* 失败必须说清原因并留重试入口：此前只有一句固定的「读取失败」，
            用户无从判断是路径写错、文件已删还是服务端读不动，只能重开整页。 */}
        {q.error ? (
          <LoadErrorNotice
            message={`读取失败：${messageOf(q.error)}`}
            onRetry={() => void q.refetch()}
            tone="secondary"
            testId="code-ref-error"
          />
        ) : null}
        {q.data && (
          <CodeBlock
            code={sliceLines(q.data.content, ref.startLine, ref.endLine)}
            lang={extOf(ref.path)}
          />
        )}
      </Collapsible>
    </div>
  )
}

function sliceLines(src: string, start: number, end: number) {
  const lines = src.split('\n')
  return lines.slice(Math.max(0, start - 1), end).join('\n')
}
