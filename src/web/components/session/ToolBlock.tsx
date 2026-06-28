import { css } from '@linaria/core'
import type { RenderBlock } from './utils/normalizeParts.js'
import { BashToolView } from './tools/BashToolView.js'
import { EditToolView } from './tools/EditToolView.js'
import { FallbackToolView } from './tools/FallbackToolView.js'
import { GlobToolView } from './tools/GlobToolView.js'
import { GrepToolView } from './tools/GrepToolView.js'
import { ReadToolView } from './tools/ReadToolView.js'
import { WriteToolView } from './tools/WriteToolView.js'

type ToolRenderBlock = Extract<RenderBlock, { type: 'tool' }>

const wrap = css`
  display: flex;
  flex-direction: column;
`

const status = css`
  font-size: 12px;
  margin-bottom: 2px;
`

const STATUS_ICON: Record<ToolRenderBlock['status'], string> = {
  running: '⏳',
  completed: '✓',
  error: '✗',
  paused: '🔒',
}

export function ToolBlock({ block }: { block: ToolRenderBlock }) {
  const { tool, input, output, status: st } = block
  return (
    <div className={wrap}>
      <span className={status} data-testid="tool-status" data-status={st}>
        {STATUS_ICON[st]}
      </span>
      {st === 'paused' ? (
        <div style={{ fontSize: 13, color: 'var(--warning)' }}>等待权限确认</div>
      ) : (
        renderTool(tool, input, output, st)
      )}
    </div>
  )
}

function renderTool(
  tool: string,
  input: unknown,
  output: ToolRenderBlock['output'],
  status: string,
) {
  switch (tool) {
    case 'read':
      return <ReadToolView input={(input ?? {}) as never} output={output} status={status} />
    case 'write':
      return <WriteToolView input={(input ?? {}) as never} />
    case 'edit':
      return <EditToolView input={(input ?? {}) as never} output={output} status={status} />
    case 'bash':
      return <BashToolView input={(input ?? {}) as never} output={output} status={status} />
    case 'grep':
      return <GrepToolView input={(input ?? {}) as never} output={output} status={status} />
    case 'glob':
      return <GlobToolView input={(input ?? {}) as never} output={output} status={status} />
    default:
      return <FallbackToolView tool={tool} input={input} output={output} />
  }
}
