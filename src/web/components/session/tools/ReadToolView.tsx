import type { ToolResult } from '@shared/types/tool.js'
import { FileCodeBlock } from '@/components/session/tools/FileCodeBlock.js'
import { ToolError } from '@/components/session/tools/toolError.js'

type ReadInput = { path: string; offset?: number; limit?: number }

export function ReadToolView({
  input,
  output,
  status,
}: {
  input: ReadInput
  output?: ToolResult
  status: string
}) {
  // 失败必须透出原因：读文件失败却渲染成一块空白，用户无从判断是路径错了还是权限问题。
  // toolErrorText 兼顾 output._tag 与 status 兜底，缺失/结构异常的 output 也会给出说明。
  if (output?._tag === 'error' || status === 'error') {
    return <ToolError output={output} status={status} />
  }
  const path = input?.path ?? ''
  const content = output?._tag === 'success' || output?._tag === 'truncated' ? output.output : ''
  return <div>{content && <FileCodeBlock path={path} content={content} />}</div>
}
