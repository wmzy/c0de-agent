import { css } from '@linaria/core'
import type { LLMSegment } from '@shared/types/agent.js'
import type { ChatTool } from '@shared/types/llm.js'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { formatCost, formatLatency, formatTokenCount } from '../utils/format.js'

const card = css`
  border: 1px solid var(--border);
  border-radius: 6px;
  margin: 8px 0;
  font-size: 13px;
`

const header = css`
  display: flex;
  gap: 12px;
  padding: 8px;
  background: var(--bg-secondary);
  flex-wrap: wrap;
`

const sectionBody = css`
  padding: 8px;
  max-height: 320px;
  overflow: auto;

  &[data-collapsed] {
    display: none;
  }
`

const section = css`
  border-top: 1px solid var(--border);

  &:first-child {
    border-top: none;
  }
`

const sectionHead = css`
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  text-align: left;
  font-size: 12px;

  &:hover {
    color: var(--text);
  }
`

const modelName = css`
  font-weight: 600;
`

const dim = css`
  color: var(--text-secondary);
`

const pre = css`
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
`

const toolItem = css`
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border);

  &:last-child {
    border-bottom: none;
    margin-bottom: 0;
  }
`

const toolHead = css`
  margin-bottom: 4px;

  strong {
    font-family: monospace;
  }
`

function ToolSchemaView({ tool }: { tool: ChatTool }) {
  return (
    <div className={toolItem}>
      <div className={toolHead}>
        <strong>{tool.name}</strong>
        <span className={dim}> — {tool.description}</span>
      </div>
      <pre className={pre}>{JSON.stringify(tool.parameters, null, 2)}</pre>
    </div>
  )
}

/**
 * 可折叠区块：默认折叠，点击切换。内容常驻 DOM，折叠态用 data-collapsed 隐藏
 * （textContent 仍可读），与 opencode web 的「摘要 + 展开原始内容」展示模式一致。
 */
function Collapsible({
  title,
  testId,
  children,
}: {
  title: string
  testId?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={section}>
      <button
        type="button"
        className={sectionHead}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid={testId}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span>{title}</span>
      </button>
      <div className={sectionBody} data-collapsed={!open || undefined}>
        {children}
      </div>
    </div>
  )
}

export function SegmentFooter({ segment }: { segment: LLMSegment }) {
  const totalTokens = segment.calls.reduce((s, c) => s + c.usage.input + c.usage.output, 0)
  const totalCost = segment.calls.reduce((s, c) => s + c.cost, 0)
  const totalLatency = segment.calls.reduce((s, c) => s + c.latency.total, 0)
  return (
    <div className={card} data-testid="segment-footer">
      <div className={header}>
        <span className={modelName}>{segment.model}</span>
        <span className={dim}>{segment.provider}</span>
        <span className={dim}>· {formatTokenCount(totalTokens)} tok</span>
        <span className={dim}>· {formatLatency(totalLatency)}</span>
        <span className={dim}>· {formatCost(totalCost)}</span>
        <span className={dim}>· {segment.calls.length} 次调用</span>
      </div>
      <Collapsible title="System Prompt">
        <pre className={pre}>{segment.systemPrompt}</pre>
      </Collapsible>
      <Collapsible title={`Tools (${segment.tools.length})`} testId="tools-summary">
        {segment.tools.length === 0 ? (
          <span className={dim}>（无工具）</span>
        ) : (
          segment.tools.map((tool) => <ToolSchemaView key={tool.name} tool={tool} />)
        )}
      </Collapsible>
    </div>
  )
}

const breakStyle = css`
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 16px 0;
  padding: 4px 0;
`

const breakLine = css`
  flex: 1;
  height: 1px;
  background: var(--border);
`

const breakLabel = css`
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
`

const BREAK_LABEL: Record<string, string> = {
  model_change: '模型切换',
  system_prompt_change: '系统提示词变更',
  tools_change: '工具集变更',
  compaction: '会话压缩',
  user_confirmed: '用户确认',
}

/** 段断裂分隔线：trigger=initial 或 user_confirmed 时不渲染。 */
export function SegmentBreak({ segment }: { segment: LLMSegment }) {
  const label = BREAK_LABEL[segment.trigger]
  if (!label) return null
  return (
    <div className={breakStyle} data-testid="segment-break">
      <span className={breakLine} />
      <span className={breakLabel}>{label}</span>
      <span className={breakLine} />
    </div>
  )
}
