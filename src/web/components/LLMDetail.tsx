import { css } from '@linaria/core'
import type { LLMDetail } from '@shared/types/agent.js'
import type { ChatMessage, ChatTool, ContentPart } from '@shared/types/llm.js'
import { formatLatency } from '../utils/format.js'

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
`

const msgItem = css`
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border);

  &:last-child {
    border-bottom: none;
    margin-bottom: 0;
  }
`

const msgMeta = css`
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--text-secondary);
`

const roleTag = css`
  font-weight: 600;
  color: var(--text);
  text-transform: uppercase;
  font-size: 11px;
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

/** 把 ChatMessage.content（string 或多模态 ContentPart[]）渲染为可读文本。 */
function renderContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .map((part) => (part.type === 'text' ? part.text : `[图片 ${part.mediaType}]`))
    .join('\n')
}

function MessageView({ message }: { message: ChatMessage }) {
  return (
    <div className={msgItem}>
      <div className={msgMeta}>
        <span className={roleTag}>{message.role}</span>
        {message.toolCallId && <span>← {message.toolCallId}</span>}
      </div>
      {renderContent(message.content) && (
        <pre className={pre}>{renderContent(message.content)}</pre>
      )}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {message.toolCalls.map((tc) => (
            <div key={tc.id}>
              <span className={roleTag}>tool</span> <em>{tc.name}</em>
              <pre className={pre}>{tc.arguments}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

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

export function LLMDetailPanel({ detail }: { detail: LLMDetail }) {
  return (
    <div className={card} data-testid="llm-detail">
      <div className={header}>
        <span>{detail.model}</span>
        <span style={{ color: 'var(--text-secondary)' }}>{detail.provider}</span>
        <span>
          {detail.usage.input} → {detail.usage.output}
        </span>
        <span style={{ color: 'var(--text-secondary)' }}>
          {formatLatency(detail.latency.total)}
        </span>
      </div>
      <details>
        <summary>System Prompt</summary>
        <pre className={sectionBody}>{detail.systemPrompt}</pre>
      </details>
      <details>
        <summary data-testid="messages-summary">Messages ({detail.messages.length})</summary>
        <div className={sectionBody}>
          {detail.messages.length === 0 ? (
            <span style={{ color: 'var(--text-secondary)' }}>（无消息）</span>
          ) : (
            detail.messages.map((msg, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 历史快照，列表静态且无 id 字段
              <MessageView key={i} message={msg} />
            ))
          )}
        </div>
      </details>
      <details>
        <summary data-testid="tools-summary">Tools ({detail.tools.length})</summary>
        <div className={sectionBody}>
          {detail.tools.length === 0 ? (
            <span style={{ color: 'var(--text-secondary)' }}>（无工具）</span>
          ) : (
            detail.tools.map((tool) => <ToolSchemaView key={tool.name} tool={tool} />)
          )}
        </div>
      </details>
      <details>
        <summary>Response</summary>
        <pre className={sectionBody}>
          {detail.responseChunks.map((c) => ('text' in c ? c.text : '')).join('')}
        </pre>
      </details>
    </div>
  )
}
