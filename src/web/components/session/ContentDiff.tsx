import { css } from '@linaria/core'
import { diffLines } from 'diff'

const wrap = css`
  margin: 4px 0;
  border-radius: 6px;
  overflow: auto;
  border: 1px solid var(--border);
  font-size: 13px;
  max-height: 400px;
`

const row = css`
  display: flex;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 0 8px;
  line-height: 1.5;
  font-family: 'SFMono-Regular', Consolas, monospace;
`

const marker = css`
  width: 16px;
  flex-shrink: 0;
  color: var(--text-secondary);
  user-select: none;
`

const added = css`
  background: var(--diff-add-bg);
  color: var(--diff-add-text);
`

const removed = css`
  background: var(--diff-del-bg);
  color: var(--diff-del-text);
`

type RowKind = 'added' | 'removed' | 'unchanged'

export function ContentDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const normalizedOld = oldText.endsWith('\n') ? oldText : `${oldText}\n`
  const normalizedNew = newText.endsWith('\n') ? newText : `${newText}\n`
  const parts = diffLines(normalizedOld, normalizedNew)
  const rows: { kind: RowKind; text: string }[] = []
  for (const part of parts) {
    const lines = part.value.split('\n')
    // diffLines 的 value 末尾常带换行，会多一个空行，去掉
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    const kind: RowKind = part.added ? 'added' : part.removed ? 'removed' : 'unchanged'
    for (const line of lines) rows.push({ kind, text: line })
  }
  return (
    <div className={wrap} data-testid="diff">
      {rows.map((r, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: diff 行无稳定 id
          key={i}
          className={`${row} ${r.kind === 'added' ? added : r.kind === 'removed' ? removed : ''}`}
          data-diff={r.kind}
        >
          <span className={marker}>
            {r.kind === 'added' ? '+' : r.kind === 'removed' ? '-' : ' '}
          </span>
          <span>{r.text}</span>
        </div>
      ))}
    </div>
  )
}
