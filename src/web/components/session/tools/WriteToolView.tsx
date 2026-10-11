import type { ToolResult } from '@shared/types/tool.js'
import { FileCodeBlock } from '@/components/session/tools/FileCodeBlock.js'
import { ToolError } from '@/components/session/tools/toolError.js'

type WriteInput = { path: string; content: string }

export function WriteToolView({
  input,
  output,
  status,
}: {
  input: WriteInput
  output?: ToolResult
  status: string
}) {
  // 写入失败必须透出原因：写失败却渲染出「即将写入的内容」会让用户以为已落盘。
  if (output?._tag === 'error' || status === 'error') {
    return <ToolError output={output} status={status} />
  }
  const path = input?.path ?? ''
  const content = input?.content ?? ''
  return (
    <div>
      <FileCodeBlock path={path} content={content} />
    </div>
  )
}
