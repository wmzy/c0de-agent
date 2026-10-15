import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { ContentDiff } from '@/components/session/ContentDiff.js'
import { ToolError } from '@/components/session/tools/toolError.js'

type EditInput =
  | { path: string; oldText: string; newText: string }
  | { path: string; patch: string }

/** edit 工具 hashline 模式随结果回传的行级变更（metadata.hunks，见 tools/hashline）。 */
type PatchHunk = { _tag: string; start: number; end: number; removed: string[]; added: string[] }

const out = css`
  margin: 4px 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--haze-color-surface-hover, rgba(127, 127, 127, 0.08));
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
`

/**
 * hunks → ContentDiff 的双侧文本。
 *
 * 按原始行号升序逐块输出：每块先插一行双侧共有的 `@@ 起-止 @@` 定位标记（未改动的
 * 上下文行，diff 里呈现为普通行），再接「被替换/删除的原始行」与「写入的新行」。
 * 拼接结果正好是 ContentDiff 期望的两份文本，且体积只与被触碰的行数相关。
 */
function hunksToDiff(hunks: PatchHunk[]): { oldText: string; newText: string } {
  const before: string[] = []
  const after: string[] = []
  for (const h of [...hunks].sort((a, b) => a.start - b.start)) {
    const mark = `@@ ${h.start}-${h.end} @@`
    before.push(mark, ...h.removed)
    after.push(mark, ...h.added)
  }
  return { oldText: before.join('\n'), newText: after.join('\n') }
}

export function EditToolView({
  input,
  output,
  status,
}: {
  input: EditInput
  output?: ToolResult
  status: string
}) {
  // 编辑失败时 diff 无意义（落盘与否未知），只给失败原因。
  if (output?._tag === 'error' || status === 'error') {
    return <ToolError output={output} status={status} />
  }
  // hashline 模式没有 oldText/newText：此前落到下面渲染 oldText='' / newText='' 的
  // 空 diff——一次真实落盘的编辑在时间线上是一块空白，用户据此以为没改成。
  if (input && 'patch' in input) {
    const hunks =
      output?._tag === 'success'
        ? ((output.metadata as { hunks?: PatchHunk[] } | undefined)?.hunks ?? [])
        : []
    if (hunks.length > 0) {
      const diff = hunksToDiff(hunks)
      return <ContentDiff oldText={diff.oldText} newText={diff.newText} />
    }
    // 没有 hunks：运行中（结果未落地）或旧消息（改动前写入的历史记录，
    // metadata 里没有这层信息）。此时给出工具自己的结论文本——至少「改了哪个
    // 文件、几个块」是真的，不再是一块空白。
    const text =
      output?._tag === 'success' || output?._tag === 'truncated' ? output.output : '正在应用补丁…'
    return (
      <div className={out} data-testid="edit-hashline-output">
        {text}
      </div>
    )
  }
  return <ContentDiff oldText={input?.oldText ?? ''} newText={input?.newText ?? ''} />
}
