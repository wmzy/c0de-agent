import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { CollapsiblePre } from '@/components/session/tools/CollapsiblePre.js'
import { ToolError, toolErrorText } from '@/components/session/tools/toolError.js'
import { resultText } from '@/components/session/tools/toolShape.js'

/** 入参区的灰底 <pre>（不折叠：入参摊平后通常只有几行，限高兜底防极端长参数）。 */
const pre = css`
  margin: 0;
  padding: 8px;
  background: var(--haze-color-bg-muted);
  border-radius: 6px;
  font-size: 13px;
  white-space: pre-wrap;
  overflow: auto;
  max-height: 400px;
`

/** 把嵌套对象拍平成 [path, value] 对，如 {a:{b:1}} => [["a.b",1]]。 */
function flatten(obj: unknown, prefix = ''): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = []
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.push(...flatten(v, key))
      } else {
        out.push([key, v])
      }
    }
  } else {
    out.push([prefix || '(value)', obj])
  }
  return out
}

export function FallbackToolView({
  input,
  output,
  status,
}: {
  tool: string
  input: unknown
  output?: ToolResult
  status?: string
}) {
  // _parseError/_raw 是后端专用的解析失败容错标记，绝不应作为参数渲染。
  const pairs = flatten(input ?? {}).filter(([k]) => k !== '_parseError' && k !== '_raw')
  // 失败必须走 ToolError：此前失败原因被塞进与成功输出同形的中性灰 <pre>，
  // 且 error 为空白串时整块渲染成空白（与 Read/Write/Edit/Grep/Glob 同一口径）。
  const errorText = toolErrorText(output, status)
  const text = resultText(output)
  return (
    <div>
      {pairs.length > 0 && (
        <pre className={pre} data-testid="fallback-args">
          {pairs
            .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join('\n')}
        </pre>
      )}
      {errorText !== null ? (
        <ToolError output={output} status={status} />
      ) : (
        text && <CollapsiblePre testId="fallback-output">{text}</CollapsiblePre>
      )}
    </div>
  )
}
