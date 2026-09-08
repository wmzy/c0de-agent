import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { sessionAPI } from '../services/session.js'
import type { ArchiveEntry, CompactionArchive } from '../types/index.js'
import { Dialog } from './Dialog.js'

const list = css`
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 50vh;
  overflow: auto;
`

const item = css`
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  padding: 8px 10px;
`

const itemHead = css`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
`

const typeBadge = css`
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  flex-shrink: 0;
`

const summary = css`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
`

const meta = css`
  color: var(--text-secondary);
  flex-shrink: 0;
`

const expandBtn = css`
  border: none;
  background: transparent;
  color: var(--primary);
  cursor: pointer;
  font-size: 12px;
  padding: 0 4px;
  min-height: auto;
  min-width: auto;
`

const archEntry = css`
  margin-top: 8px;
  padding: 6px 8px;
  border-left: 2px solid var(--border);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary);
`

const archRole = css`
  font-weight: 600;
  color: var(--text);
  margin-bottom: 2px;
`

const empty = css`
  color: var(--text-secondary);
  font-size: 13px;
  text-align: center;
  padding: 16px;
`

const searchInput = css`
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
`

const hint = css`
  color: var(--text-secondary);
  font-size: 12px;
  margin-top: 4px;
`

const TYPE_LABEL: Record<CompactionArchive['archiveType'], string> = {
  compaction: '压缩',
  squash: '归并',
  shake: 'Shake',
  clear: '清空',
}

/** 归档条目 → 可读文本（role + 内容摘要；工具调用/结果转 JSON 片段）。 */
function entryToText(entry: ArchiveEntry): { role: string; text: string } {
  if ('summary' in entry && '_tag' in entry) {
    return { role: entry._tag, text: entry.summary }
  }
  if ('_tag' in entry) {
    return { role: 'steering', text: entry.content }
  }
  const text = (entry.content ?? [])
    .map((part) => {
      if (part.text !== undefined) return part.text
      if (part.tool !== undefined) return `[${part.tool}] ${JSON.stringify(part.input ?? '')}`
      if (part.output !== undefined) return JSON.stringify(part.output)
      return ''
    })
    .join('\n')
  return { role: entry.role, text }
}

/** 会话归档面板：compaction/squash/shake/clear 的原始内容浏览与搜索（只读）。 */
export function ArchivePanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['session', sessionId, 'archives', q],
    queryFn: () => sessionAPI.archives(sessionId, q || undefined),
  })
  const archives = data?.archives ?? []

  return (
    <Dialog onClose={onClose} title="会话归档" width="min(560px, 94vw)" testId="archive-panel">
      <input
        className={searchInput}
        type="search"
        placeholder="搜索归档内容…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        data-testid="archive-search"
      />
      <div className={list}>
        {isLoading ? <div className={empty}>加载中…</div> : null}
        {!isLoading && archives.length === 0 ? (
          <div className={empty}>暂无归档（/clear、Shake、压缩产生的内容会保留在这里）</div>
        ) : null}
        {archives.map((a) => (
          <div key={a.id} className={item}>
            <div className={itemHead}>
              <span className={typeBadge}>{TYPE_LABEL[a.archiveType]}</span>
              <span className={summary} title={a.summary}>
                {a.summary}
              </span>
              <span className={meta} title="归档时估算的 token 数（启发式，非精确计费值）">
                {new Date(a.createdAt).toLocaleString()} · {a.originalEntries.length} 条 · ~
                {a.tokenCount}t
              </span>
              <button
                type="button"
                className={expandBtn}
                onClick={() => setExpanded(expanded === a.id ? null : a.id)}
                data-testid={`archive-expand-${a.id}`}
              >
                {expanded === a.id ? '收起' : '展开'}
              </button>
            </div>
            {expanded === a.id && (
              <div>
                {a.originalEntries.map((orig: ArchiveEntry, idx: number) => {
                  const { role: entryRole, text } = entryToText(orig)
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 归档条目无稳定 id，a.id+idx 在列表内唯一
                    <div key={`${a.id}-${idx}`} className={archEntry}>
                      <div className={archRole}>{entryRole}</div>
                      {text}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      <p className={hint}>归档内容只读保留，可在此查看、复制；不会被发送给模型。</p>
    </Dialog>
  )
}
