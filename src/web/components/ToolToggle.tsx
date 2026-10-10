import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toolAPI } from '@/services/tool.js'
import { cardStyle, inputStyle } from '@/styles/tokens.js'

const wrap = css`
  position: relative;
`

const trigger = css`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  min-height: 28px;
  color: var(--haze-color-text);
  font-size: 12px;
  cursor: pointer;

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`

const badgeActive = css`
  color: var(--haze-color-text-secondary);
  font-weight: 600;
`

const badgePartial = css`
  color: #f59e0b;
  font-weight: 700;
`

const badgeNone = css`
  color: var(--haze-color-danger, #e5484d);
  font-weight: 700;
`

const menu = css`
  position: absolute;
  bottom: 100%;
  right: 0;
  margin-bottom: 4px;
  min-width: 260px;
  max-width: 360px;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  box-shadow: var(--haze-shadow-md);
  z-index: 50;
`

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 12px;
  color: var(--haze-color-text-secondary);
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
    background: var(--haze-color-bg-subtle);
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
  color: var(--haze-color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const empty = css`
  padding: 16px 12px;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
  text-align: center;
`

/** 失败态里的重试按钮：与上方原因行留出间距。 */
const retryBtn = css`
  margin-top: 8px;
`

const hintLine = css`
  padding: 8px 12px;
  border-top: 1px solid var(--haze-color-border);
  font-size: 11px;
  color: var(--haze-color-text-secondary);
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
  projectId,
}: {
  enabled: Set<string> | null
  onChange: (next: Set<string> | null) => void
  disabled?: boolean
  /** P2 交集语义：工具列表按该项目合并配置过滤（与服务端解析同口径）。 */
  projectId?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const {
    data: tools,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['tools', projectId ?? 'server'],
    queryFn: () => toolAPI.list(projectId),
    staleTime: 60_000,
  })

  const names = (tools ?? []).map((t) => t.name)
  const total = names.length
  // 读取失败必须与「确实没有工具」区分：失败时 total 为 0，若不特判，
  // 徽标会落到「全部」（enabled===null）或 `${enabled.size}/0`（显式集合时
  // 如「5/0」），菜单里则断言「暂无可用工具」——把「这次没拉到」说成
  // 「工具没注册/被清空了」，且 staleTime 内不会自愈、也没有重试入口。
  const failed = isError && total === 0
  const errorMessage =
    (error as { message?: string } | null)?.message ??
    (error instanceof Error ? error.message : null)
  // enabled === null 视为全部启用
  const enabledCount = enabled === null ? total : enabled.size
  const isAllEnabled = enabled === null || (total > 0 && names.every((n) => enabled.has(n)))
  const isNoneEnabled = enabled !== null && enabled.size === 0

  // 点击组件外部 / Escape 关闭弹层。此前这里只挂了 mousedown：键盘用户 Tab 到
  // 「工具」按 Enter 展开后，唯一的关闭路径是点击组件外部——Esc 无任何监听者，
  // 菜单关不掉，只能逐个 Tab 走完菜单内全部控件才能离开（与 ModelSelector 的同一
  // 浮层模式不一致，后者 mousedown + keydown Escape 都有）。Esc 关闭后把焦点交还
  // 触发按钮，避免焦点随菜单卸载掉回 body、下一次 Tab 从文档头重来。
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 展开时把焦点送入菜单（role="menu" 的键盘约定）：否则焦点停在触发按钮上，
  // 菜单虽开却不在键盘可达流里，Esc 也关不掉。
  useEffect(() => {
    if (open) menuRef.current?.focus()
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
  ) : failed ? (
    <span className={badgeNone} title="工具列表加载失败" data-testid="tool-badge-error">
      ?
    </span>
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
        ref={triggerRef}
        data-testid="tool-toggle"
      >
        工具
        {badge}
      </button>
      {open && (
        <div
          className={menu}
          role="menu"
          aria-label="工具开关"
          ref={menuRef}
          tabIndex={-1}
          data-testid="tool-menu"
        >
          <div className={header}>
            <span>{failed ? '工具 —' : `工具 ${enabledCount}/${total}`}</span>
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
            {failed ? (
              <div className={empty} role="alert" data-testid="tool-list-error">
                <div>工具列表加载失败{errorMessage ? `：${errorMessage}` : '，请稍后重试。'}</div>
                <button
                  type="button"
                  className={`${inputStyle} ${headerBtn} ${retryBtn}`}
                  onClick={() => void refetch()}
                  data-testid="tool-list-retry"
                >
                  重试
                </button>
              </div>
            ) : total === 0 ? (
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
          <div className={hintLine} data-testid="tool-toggle-hint">
            {enabled === null
              ? '默认启用全部注册工具（含未来版本新增工具）'
              : `已显式选择 ${enabled.size} 个工具：后续版本新增的工具不会自动启用，「全选」可恢复默认`}
          </div>
        </div>
      )}
    </div>
  )
}
