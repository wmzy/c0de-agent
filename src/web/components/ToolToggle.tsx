import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toolAPI } from '../services/tool.js'
import { cardStyle, inputStyle } from '../styles/tokens.js'

const wrap = css`
  position: relative;
`

const trigger = css`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  min-height: 28px;
  color: var(--text);
  font-size: 12px;
  cursor: pointer;

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`

const badgeActive = css`
  color: var(--text-secondary);
  font-weight: 600;
`

const badgePartial = css`
  color: #f59e0b;
  font-weight: 700;
`

const badgeNone = css`
  color: var(--danger, #e5484d);
  font-weight: 700;
`

const menu = css`
  position: absolute;
  bottom: 100%;
  right: 0;
  margin-bottom: 4px;
  min-width: 260px;
  max-width: 360px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
  z-index: 50;
`

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-secondary);
`

const headerBtns = css`
  display: flex;
  gap: 8px;
`

const headerBtn = css`
  padding: 2px 6px;
  font-size: 11px;
  cursor: pointer;
`

const list = css`
  max-height: 280px;
  overflow-y: auto;
`

const item = css`
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;

  &:hover {
    background: var(--bg-secondary);
  }
`

const itemText = css`
  display: flex;
  flex-direction: column;
  min-width: 0;
`

const itemName = css`
  font-weight: 600;
  font-size: 13px;
`

const itemDesc = css`
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const empty = css`
  padding: 16px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  text-align: center;
`

/**
 * 输入区工具开关：列出可用工具，按名勾选；启用的工具随消息发送给后端（白名单）。
 *
 * - `enabled === null`：默认全启用，发送时不传 tools，后端启用全部注册工具。
 * - `enabled` 为 Set：用户显式选择，发送时传 Array.from(set)。
 */
export function ToolToggle({
  enabled,
  onChange,
  disabled,
}: {
  enabled: Set<string> | null
  onChange: (next: Set<string> | null) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const { data: tools, isLoading } = useQuery({
    queryKey: ['tools'],
    queryFn: () => toolAPI.list(),
    staleTime: 60_000,
  })

  const names = (tools ?? []).map((t) => t.name)
  const total = names.length
  // enabled === null 视为全部启用
  const enabledCount = enabled === null ? total : enabled.size
  const isAllEnabled = enabled === null || (total > 0 && names.every((n) => enabled.has(n)))
  const isNoneEnabled = enabled !== null && enabled.size === 0

  // 点击组件外部关闭弹层
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const isChecked = (name: string): boolean => (enabled === null ? true : enabled.has(name))

  const toggle = (name: string) => {
    // 首次操作：从默认全启用具象化为显式集合再增删
    const next = enabled === null ? new Set(names) : new Set(enabled)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    onChange(next)
  }

  const badge = isLoading ? (
    <span className={badgeActive}>…</span>
  ) : isAllEnabled ? (
    <span className={badgeActive}>全部</span>
  ) : isNoneEnabled ? (
    <span className={badgeNone}>已禁用</span>
  ) : (
    <span className={badgePartial}>{`${enabledCount}/${total}`}</span>
  )

  return (
    <div className={wrap} ref={ref}>
      <button
        type="button"
        className={`${cardStyle} ${trigger}`}
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="true"
        data-testid="tool-toggle"
      >
        工具
        {badge}
      </button>
      {open && (
        <div className={menu} role="menu" data-testid="tool-menu">
          <div className={header}>
            <span>{`工具 ${enabledCount}/${total}`}</span>
            <span className={headerBtns}>
              <button
                type="button"
                className={`${inputStyle} ${headerBtn}`}
                onClick={() => onChange(null)}
                data-testid="tool-select-all"
              >
                全选
              </button>
              <button
                type="button"
                className={`${inputStyle} ${headerBtn}`}
                onClick={() => onChange(new Set())}
                data-testid="tool-clear"
              >
                清除
              </button>
            </span>
          </div>
          <div className={list}>
            {total === 0 ? (
              <div className={empty}>{isLoading ? '加载中…' : '暂无可用工具'}</div>
            ) : (
              (tools ?? []).map((t) => (
                <label key={t.name} className={item} data-testid={`tool-item-${t.name}`}>
                  <input
                    type="checkbox"
                    checked={isChecked(t.name)}
                    onChange={() => toggle(t.name)}
                    data-testid={`tool-check-${t.name}`}
                  />
                  <span className={itemText}>
                    <span className={itemName}>{t.name}</span>
                    <span className={itemDesc}>{t.description}</span>
                  </span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
