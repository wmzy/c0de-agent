import { css } from '@linaria/core'
import { CheckSquare, ChevronDown, Square, X, Zap } from 'lucide-react'
import { useState } from 'react'
import type { ShakeRegionView } from '../types/index.js'

const overlay = css`
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 50%);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
`

const panel = css`
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 600px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
`

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
  font-size: 14px;
`

const toolbar = css`
  display: flex;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  align-items: center;
`

const toolbarBtn = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  &:hover {
    background: var(--bg-secondary);
  }
`

const regionList = css`
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
`

const regionRow = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  cursor: pointer;
  &:hover {
    background: var(--bg-secondary);
  }
`

const regionLabel = css`
  font-size: 13px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const tokenBadge = css`
  font-size: 11px;
  color: var(--text-secondary);
  font-family: ui-monospace, monospace;
  white-space: nowrap;
`

const previewText = css`
  font-size: 11px;
  color: var(--text-tertiary);
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const footer = css`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
`

const primaryBtn = css`
  padding: 6px 16px;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  &:hover {
    opacity: 0.9;
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`

const secondaryBtn = css`
  padding: 6px 16px;
  background: transparent;
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
`

const emptyState = css`
  padding: 40px 16px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
`

export function ShakePanel({
  regions,
  fromIndex,
  onSubmit,
  onClose,
}: {
  regions: ShakeRegionView[]
  fromIndex?: number
  onSubmit: (regionIds: string[]) => void
  onClose: () => void
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(regions.filter((r) => r.isAfterProtectWindow).map((r) => r.id)),
  )

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => setSelected(new Set(regions.map((r) => r.id)))
  const deselectAll = () => setSelected(new Set())
  const selectFromHere = () => {
    if (fromIndex === undefined) return
    setSelected(new Set(regions.filter((r) => r.messageIndex >= fromIndex).map((r) => r.id)))
  }

  const selectedTokens = [...selected].reduce(
    (sum, id) => sum + (regions.find((r) => r.id === id)?.tokens ?? 0),
    0,
  )

  return (
    <div className={overlay} data-testid="shake-panel" role="dialog" aria-modal="true">
      <div className={panel}>
        <div className={header}>
          <span>
            <Zap size={14} style={{ display: 'inline', marginRight: 6 }} />
            Shake — 机械裁剪重内容
          </span>
          <button
            onClick={onClose}
            type="button"
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {regions.length === 0 ? (
          <div className={emptyState} data-testid="shake-empty">
            没有可 shake 的内容
          </div>
        ) : (
          <>
            <div className={toolbar}>
              <button
                className={toolbarBtn}
                onClick={selectAll}
                type="button"
                data-testid="shake-select-all"
              >
                <CheckSquare size={12} /> 全选
              </button>
              {fromIndex !== undefined && (
                <button
                  className={toolbarBtn}
                  onClick={selectFromHere}
                  type="button"
                  data-testid="shake-select-from-here"
                >
                  <ChevronDown size={12} /> 选当前及以下
                </button>
              )}
              <button
                className={toolbarBtn}
                onClick={deselectAll}
                type="button"
                data-testid="shake-deselect-all"
              >
                <Square size={12} /> 取消全选
              </button>
              <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)' }}>
                已选 {selected.size}/{regions.length} · 省 {selectedTokens}t
              </span>
            </div>

            <div className={regionList}>
              {regions.map((r) => (
                <label key={r.id} className={regionRow} data-testid={`shake-region-${r.id}`}>
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                  <span className={regionLabel}>
                    {r.kind === 'toolResult' ? '🔧' : '📄'} {r.label}
                    {!r.isAfterProtectWindow && (
                      <span style={{ color: 'var(--text-tertiary)', marginLeft: 4 }}>⚠</span>
                    )}
                  </span>
                  <span className={tokenBadge}>{r.tokens}t</span>
                  <span className={previewText} title={r.preview}>
                    {r.preview}
                  </span>
                </label>
              ))}
            </div>

            <div className={footer}>
              <button
                className={secondaryBtn}
                onClick={onClose}
                type="button"
                data-testid="shake-cancel"
              >
                取消
              </button>
              <button
                className={primaryBtn}
                onClick={() => onSubmit([...selected])}
                type="button"
                disabled={selected.size === 0}
                data-testid="shake-submit"
              >
                提交 Shake
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
