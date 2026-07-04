import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { useOverflow } from '../hooks/useOverflow.js'

const pre = css`
  margin: 0;
  padding: 8px;
  background: var(--code-bg);
  border-radius: 6px;
  font-size: 13px;
  white-space: pre-wrap;
  overflow: auto;
  max-height: 400px;
`

const collapsed = css`
  max-height: 200px;
  overflow: hidden;
`

const btn = css`
  font-size: 12px;
  color: var(--primary);
  background: transparent;
  border: none;
  cursor: pointer;
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
  tool,
  input,
  output,
}: {
  tool: string
  input: unknown
  output?: ToolResult
}) {
  // _parseError/_raw 是后端专用的解析失败容错标记，绝不应作为参数渲染。
  const pairs = flatten(input ?? {}).filter(([k]) => k !== '_parseError' && k !== '_raw')
  const resultText =
    output?._tag === 'success' || output?._tag === 'truncated'
      ? output.output
      : output?._tag === 'error'
        ? output.error
        : ''
  const { ref, overflowing, expanded, toggle } = useOverflow(200)
  const showToggle = overflowing && !expanded
  return (
    <div>
      {pairs.length > 0 && (
        <pre className={pre} data-testid="fallback-args">
          {pairs
            .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join('\n')}
        </pre>
      )}
      {resultText && (
        <div>
          <div ref={ref} className={showToggle ? collapsed : ''}>
            <pre className={pre} data-testid="fallback-output">
              {resultText}
            </pre>
          </div>
          {overflowing && (
            <button type="button" className={btn} onClick={toggle}>
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
