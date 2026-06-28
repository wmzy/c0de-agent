import { css } from '@linaria/core'
import type { LLMDetail } from '@shared/types/agent.js'
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

const roleBadge = css`
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 4px;
`

const costValue = css`
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

export function LLMDetailPanel({ detail }: { detail: LLMDetail }) {
  return (
    <div className={card} data-testid="llm-detail">
      <div className={header}>
        <span className={modelName}>{detail.model}</span>
        <span className={dim}>{detail.provider}</span>
        <span className={roleBadge}>{detail.role._tag}</span>
        <span className={dim}>
          {formatTokenCount(detail.usage.input)} → {formatTokenCount(detail.usage.output)}
        </span>
        {detail.usage.cacheRead != null && (
          <span className={dim}>cache {formatTokenCount(detail.usage.cacheRead)}</span>
        )}
        <span className={costValue}>{formatCost(detail.cost)}</span>
        <span className={dim}>{formatLatency(detail.latency.total)}</span>
      </div>
      <Collapsible title="System Prompt">
        <pre className={pre}>{detail.systemPrompt}</pre>
      </Collapsible>
      <Collapsible title={`Messages (${detail.messages.length})`} testId="messages-summary">
        {detail.messages.length === 0 ? (
          <span className={dim}>（无消息）</span>
        ) : (
          detail.messages.map((msg, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 历史快照，列表静态且无 id 字段
            <pre className={pre} key={i}>
              {JSON.stringify(msg, null, 2)}
            </pre>
          ))
        )}
      </Collapsible>
      <Collapsible title={`Tools (${detail.tools.length})`} testId="tools-summary">
        {detail.tools.length === 0 ? (
          <span className={dim}>（无工具）</span>
        ) : (
          detail.tools.map((tool) => <ToolSchemaView key={tool.name} tool={tool} />)
        )}
      </Collapsible>
      {detail.thinking && (
        <Collapsible title="Thinking">
          <pre className={pre}>{detail.thinking}</pre>
        </Collapsible>
      )}
      <Collapsible title="Response">
        <pre className={pre}>
          {detail.responseChunks.map((c) => ('text' in c ? c.text : '')).join('')}
        </pre>
      </Collapsible>
    </div>
  )
}
