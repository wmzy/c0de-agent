import type { ToolResult } from '@shared/types/tool.js'
import { FallbackToolView } from '@/components/session/tools/FallbackToolView.js'
import { FileCodeBlock } from '@/components/session/tools/FileCodeBlock.js'
import { ToolError } from '@/components/session/tools/toolError.js'
import { strArg } from '@/components/session/tools/toolShape.js'

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
  // path/content 都是原样落库的 JSON：模型把 content 写成 {lines:[...]} 时，
  // FileCodeBlock 的 extToLang(path) 与 <pre>{content}</pre> 在渲染期抛错，整个应用
  // 壳被换成「页面渲染出错」。读不出来就退回兜底视图——既不能用空串冒充「写入的
  // 内容是空的」，也不能因此隐藏这次写入的原始入参。
  const path = strArg(input, 'path')
  const content = strArg(input, 'content')
  if (path.broken || content.broken || content.value === undefined) {
    return <FallbackToolView tool="write" input={input} output={output} status={status} />
  }
  return (
    <div>
      <FileCodeBlock path={path.value ?? ''} content={content.value} />
    </div>
  )
}
