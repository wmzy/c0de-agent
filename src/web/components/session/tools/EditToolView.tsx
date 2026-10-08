import type { ToolResult } from '@shared/types/tool.js'
import { ContentDiff } from '@/components/session/ContentDiff.js'
import { ToolError } from '@/components/session/tools/toolError.js'

type EditInput = { path: string; oldText: string; newText: string }

export function EditToolView({
  input,
  output,
  status,
}: {
  input: EditInput
  output?: ToolResult
  status: string
}) {
  const oldText = input?.oldText ?? ''
  const newText = input?.newText ?? ''
  // 编辑失败时 diff 无意义（落盘与否未知），只给失败原因。
  if (output?._tag === 'error' || status === 'error') {
    return <ToolError output={output} status={status} />
  }
  return <ContentDiff oldText={oldText} newText={newText} />
}
