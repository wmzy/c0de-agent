import { css } from '@linaria/core'
import type { LLMCall, LLMSegment } from '@shared/types/agent.js'
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
        <span style={{ color: 'var(--text-secondary)' }}> — {tool.description}</span>
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

export function SegmentHeader({ segment }: { segment: LLMSegment }) {
  return (
    <div className={card} data-testid="segment-header">
      <div className={header}>
        <span className={modelName}>{segment.model}</span>
        <span className={dim}>{segment.provider}</span>
        <span className={dim}>· {segment.trigger}</span>
        {segment.contextWindow != null && (
          <span className={dim}>ctx {formatTokenCount(segment.contextWindow)}</span>
        )}
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

export function CallRow({ call, index }: { call: LLMCall; index: number }) {
  return (
    <div className={card} data-testid="call-row">
      <div className={header}>
        <span className={modelName}>调用 #{index}</span>
        <span className={dim}>{new Date(call.timestamp).toLocaleString()}</span>
        <span className={dim}>
          {formatTokenCount(call.usage.input)} in · {formatTokenCount(call.usage.output)} out
        </span>
        {call.usage.cacheRead != null && (
          <span className={dim}>cache {formatTokenCount(call.usage.cacheRead)}</span>
        )}
        <span className={dim}>{formatLatency(call.latency.total)}</span>
        <span className={dim}>{formatCost(call.cost)}</span>
        {call.finishReason && <span className={dim}>· {call.finishReason}</span>}
      </div>
      {call.thinking && (
        <Collapsible title="Thinking">
          <pre className={pre}>{call.thinking}</pre>
        </Collapsible>
      )}
      <Collapsible title="Response">
        <pre className={pre}>{call.responseText}</pre>
      </Collapsible>
    </div>
  )
}
