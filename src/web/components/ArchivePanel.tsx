import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Dialog } from '@/components/Dialog.js'
import { SyncedInput } from '@/components/SyncedControls.js'
import { sessionAPI } from '@/services/session.js'
import type { ArchiveEntry, CompactionArchive } from '@/types/index.js'

const list = css`
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 50vh;
  overflow: auto;
`

const item = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  background: var(--haze-color-bg);
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
  background: var(--haze-color-bg-subtle);
  border: 1px solid var(--haze-color-border);
  color: var(--haze-color-text-secondary);
  flex-shrink: 0;
`

const summary = css`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--haze-color-text);
`

const meta = css`
  color: var(--haze-color-text-secondary);
  flex-shrink: 0;
`

const expandBtn = css`
  border: none;
  background: transparent;
  color: var(--haze-color-primary);
  cursor: pointer;
  font-size: 12px;
  padding: 0 4px;
  min-height: auto;
  min-width: auto;
`

const archEntry = css`
  margin-top: 8px;
  padding: 6px 8px;
  border-left: 2px solid var(--haze-color-border);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--haze-color-text-secondary);
`

const archRole = css`
  font-weight: 600;
  color: var(--haze-color-text);
  margin-bottom: 2px;
`

const empty = css`
  color: var(--haze-color-text-secondary);
  font-size: 13px;
  text-align: center;
  padding: 16px;
`

const searchInput = css`
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  font-size: 13px;
`

const hint = css`
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  margin-top: 4px;
`

/**
 * 归档读失败态。此前只有 isLoading 一个状态位：请求 500 时 data 为 undefined
 * → archives 恒为 []，与「真的没有归档」落进同一分支。
 */
const errorState = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 20px 16px;
  text-align: center;
`

const errorTitle = css`
  color: var(--haze-color-danger);
  font-size: 13px;
  font-weight: 600;
`

const errorDetail = css`
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  /* 后端 message 可能是长路径/长句，窄弹层内必须断行 */
  overflow-wrap: anywhere;
`

const retryBtn = css`
  padding: 4px 14px;
  font-size: 12px;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  cursor: pointer;

  &:hover {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-primary);
  }
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
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['session', sessionId, 'archives', q],
    queryFn: () => sessionAPI.archives(sessionId, q || undefined),
  })
  const archives = data?.archives ?? []

  return (
    <Dialog onClose={onClose} title="会话归档" width="min(560px, 94vw)" testId="archive-panel">
      <SyncedInput
        className={searchInput}
        type="search"
        placeholder="搜索归档内容…"
        aria-label="搜索归档内容"
        value={q}
        onChange={(v) => setQ(v)}
        data-testid="archive-search"
      />
      <div className={list}>
        {isLoading ? <div className={empty}>加载中…</div> : null}
        {/* 拉不到 ≠ 没有：此前失败与空态合并成「暂无归档」，用户据此认定
            /clear、Shake、压缩的历史内容丢了（实测注入 500，稳定显示这句）。
            与 RecycleBin / KanbanView 同一套三段式：标题 + 后端原因 + 重试。 */}
        {isError ? (
          <div className={errorState} role="alert" data-testid="archive-load-error">
            <span className={errorTitle}>归档加载失败</span>
            <span className={errorDetail}>
              {(error as { message?: string } | null)?.message ??
                (error instanceof Error ? error.message : null) ??
                '无法读取归档内容。'}
            </span>
            <button
              type="button"
              className={retryBtn}
              onClick={() => refetch()}
              data-testid="archive-retry"
            >
              重试
            </button>
          </div>
        ) : null}
        {!isLoading && !isError && archives.length === 0 ? (
          // 「搜不到」与「没有归档」是两件事：搜索无命中时此前渲染的是空态那句
          // 「暂无归档（/clear、Shake、压缩产生的内容会保留在这里）」——用户刚在
          // 列表里看到两条归档，输入一个不存在的词就被告诉「暂无归档」，只会认定
          // 历史内容已经被清了，进而去翻备份。与侧栏会话搜索 / 回收站搜索 /
          // 文件面板同口径：有查询词时说的是「没有匹配」。
          q.trim() ? (
            <div className={empty} data-testid="archive-no-match">
              {`没有匹配「${q.trim()}」的归档`}
            </div>
          ) : (
            <div className={empty}>暂无归档（/clear、Shake、压缩产生的内容会保留在这里）</div>
          )
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
