import type { ToolResult } from '@shared/types/tool.js'
import { FallbackToolView } from '@/components/session/tools/FallbackToolView.js'
import { FileCodeBlock } from '@/components/session/tools/FileCodeBlock.js'
import { ToolError } from '@/components/session/tools/toolError.js'
import { strArg } from '@/components/session/tools/toolShape.js'

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
  // input 是原样落库的 JSON：path 被写成对象时 extToLang 的 filename.split() 会在
  // 渲染期抛错，把整个应用壳换成「页面渲染出错」。读不出来就退回兜底视图（原始
  // 入参摊平显示），不用空 path 冒充「读的正是这个文件」。
  const path = strArg(input, 'path')
  if (path.broken) {
    return <FallbackToolView tool="read" input={input} output={output} status={status} />
  }
  const content = output?._tag === 'success' || output?._tag === 'truncated' ? output.output : ''
  return <div>{content && <FileCodeBlock path={path.value ?? ''} content={content} />}</div>
}
