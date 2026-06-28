import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { CodeBlock } from '../../CodeBlock.js'
import { useOverflow } from '../hooks/useOverflow.js'

const title = css`
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 4px;
`

const name = css`
  color: var(--text);
  font-weight: 500;
`

const out = css`
  margin: 4px 0 0;
  padding: 8px;
  background: var(--code-bg);
  border-radius: 6px;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 400px;
`

const collapsed = css`
  max-height: 200px;
`

const btn = css`
  font-size: 12px;
  color: var(--primary);
  background: transparent;
  border: none;
  cursor: pointer;
`

const exitOk = css`
  font-size: 12px;
  color: var(--success);
`
const exitErr = css`
  font-size: 12px;
  color: var(--error);
`

type BashInput = { command: string; cwd?: string; timeout?: number }

export function BashToolView({
  input,
  output,
  status,
}: {
  input: BashInput
  output?: ToolResult
  status: string
}) {
  const command = input?.command ?? ''
  const { ref, overflowing, expanded, toggle } = useOverflow(200)
  const showToggle = overflowing && !expanded

  // 成功：output.output + metadata.exitCode
  let outText = ''
  let exitCode: number | null = null
  if (output?._tag === 'success') {
    outText = output.output
    exitCode = typeof output.metadata?.exitCode === 'number' ? output.metadata.exitCode : null
  } else if (output?._tag === 'truncated') {
    outText = output.output
  } else if (output?._tag === 'error') {
    outText = output.error
    // 失败时无 metadata，从 error 文本提取 exit code
    const m = output.error.match(/exit code:?\s*(\d+)/i)
    exitCode = m ? Number(m[1]) : null
  }

  return (
    <div>
      <div className={title}>
        <span className={name}>bash</span>
      </div>
      <div data-testid="bash-command">
        <CodeBlock code={command} lang="bash" />
      </div>
      {outText && (
        <div>
          <div ref={ref} className={showToggle ? collapsed : ''}>
            <pre data-testid="bash-output" className={out}>
              {outText}
            </pre>
          </div>
          {overflowing && (
            <button type="button" className={btn} onClick={toggle}>
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </div>
      )}
      {exitCode !== null && status !== 'running' && (
        <span
          className={exitCode === 0 ? exitOk : exitErr}
          data-testid="bash-exit"
          style={{ marginLeft: 4 }}
        >
          exit {exitCode}
        </span>
      )}
    </div>
  )
}