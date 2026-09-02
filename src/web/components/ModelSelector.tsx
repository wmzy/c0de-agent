import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useConfig } from '../contexts/ConfigContext.js'
import { providerAPI } from '../services/provider.js'
import { inputStyle } from '../styles/tokens.js'

const field = css`
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
`

/** 基础控件增量样式。注意：wyw-in-js 不会把 `${control}` 的样式内联进派生类，
 * 派生类只生成增量；故每个控件需自包含 min-height，否则被全局 select/input{min-height:44px} 覆盖；
 * 边框/圆角/背景/文字色来自 inputStyle。 */
const selectControl = css`
  padding: 4px 28px 4px 8px;
  min-height: 28px;
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
`

const input = css`
  padding: 4px 8px;
  min-width: 180px;
  min-height: 28px;
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
`

/** Model 字段：input + 下拉按钮 + 弹出列表，统一相对定位。 */
const modelWrap = css`
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 0;
`

const dropdownBtn = css`
  padding: 4px 8px;
  min-height: 28px;
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  border-left: none;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
`

/** 弹出列表：向上展开（footer 位于视口底部，向下开会被 main 的
 * overflow:hidden 裁剪）；右对齐锚点 + 限宽，窄屏不产生横向溢出。
 * 视觉沿用 DropdownMenu panel（边框/圆角/阴影）。 */
const hintList = css`
  position: absolute;
  bottom: calc(100% + 2px);
  right: 0;
  z-index: 10;
  min-width: 180px;
  max-width: min(360px, calc(100vw - 24px));
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  box-shadow: var(--shadow, 0 4px 12px rgba(0, 0, 0, 0.15));
  display: flex;
  flex-direction: column;
  padding: 4px 0;
`

const hintItem = css`
  padding: 6px 10px;
  font: inherit;
  font-size: 12px;
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  &:hover {
    background: var(--bg-secondary);
  }
`

/** 键盘/悬停高亮项。 */
const hintItemHighlight = css`
  background: var(--bg-secondary);
`

/** 当前已选中的模型名。 */
const hintItemActive = css`
  color: var(--primary);
  font-weight: 600;
`

/** 过滤无匹配时的空态提示。 */
const hintEmpty = css`
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

export type ModelSelection = { provider: string; model: string }

/** 输入框上方的 Provider + Model 切换器。
 * provider 来自已配置列表（/api/providers）；model 为可搜索下拉 + 自由输入：
 * - 建议项取自该 provider 在 config 中预定义且启用的模型（enabled 省略/true）；
 * - 点击 ▾ / 聚焦输入框打开列表时始终展示全部启用模型（可逃逸过滤），
 *   随后在输入框中键入即按子串（忽略大小写）过滤；
 * - 允许输入列表外的自定义模型名（不合规则不清空输入）；
 * - 点击或 ↑↓+Enter 选中后回填输入框。 */
export function ModelSelector({
  value,
  onChange,
}: {
  value: ModelSelection
  onChange: (v: ModelSelection) => void
}) {
  const { data } = useQuery({
    queryKey: ['providers'],
    queryFn: () => providerAPI.list(),
    staleTime: 60_000,
  })
  const { config } = useConfig()

  const providers = data?.providers ?? []
  const hasMatch = providers.some((p) => p.name === value.provider)

  // 当前 provider 在 config 中预定义的模型名（作为输入建议）
  const configured = config?.providers ?? []
  const current = configured.find((p) => p.name === value.provider)
  // 仅提示启用的模型（enabled 省略/true 视为启用）
  const modelHints = useMemo(
    () =>
      current?.models
        ? Object.entries(current.models)
            .filter(([, v]) => v.enabled !== false)
            .map(([name]) => name)
        : [],
    [current],
  )

  const [hintsOpen, setHintsOpen] = useState(false)
  // 过滤词：null = 未过滤。打开列表时重置为 null（展示全部，可逃逸过滤），
  // 仅在输入框键入时更新为所键入的文本。
  const [query, setQuery] = useState<string | null>(null)
  // 键盘/悬停高亮项索引，-1 表示无
  const [highlight, setHighlight] = useState(-1)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  // pick() 后把焦点还给输入框；跳过 onFocus 的自动展开，避免列表重新弹出
  const skipOpenRef = useRef(false)

  const visible = useMemo(
    () =>
      query === null
        ? modelHints
        : modelHints.filter((m) => m.toLowerCase().includes(query.toLowerCase())),
    [modelHints, query],
  )

  const closeHints = useCallback(() => {
    setHintsOpen(false)
    setQuery(null)
    setHighlight(-1)
  }, [])

  const openHints = () => {
    setHintsOpen(true)
    setQuery(null)
    setHighlight(-1)
  }

  const pick = (m: string) => {
    onChange({ ...value, model: m })
    skipOpenRef.current = true
    closeHints()
    inputRef.current?.focus()
    // input 已聚焦时 focus() 不触发 focus 事件，标志会残留并吞掉下一次
    // 真实聚焦的自动展开；微任务里兜底复位（focus 事件同步派发，先于此执行）。
    queueMicrotask(() => {
      skipOpenRef.current = false
    })
  }

  // 点击外部 / Escape 关闭（同 DropdownMenu 模式）
  useEffect(() => {
    if (!hintsOpen) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        closeHints()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeHints()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [hintsOpen, closeHints])

  // 高亮项滚入可视区（jsdom 无 scrollIntoView，用可选调用兜底）
  useEffect(() => {
    if (!hintsOpen || highlight < 0) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [highlight, hintsOpen])

  return (
    <>
      <label className={field}>
        <span>Provider</span>
        <select
          className={`${inputStyle} ${selectControl}`}
          value={value.provider}
          onChange={(e) => {
            onChange({ ...value, provider: e.target.value })
            // 切换 provider 后旧列表不再适用，直接收起
            closeHints()
          }}
          data-testid="provider-select"
        >
          {!hasMatch && value.provider ? (
            <option value={value.provider}>{value.provider}</option>
          ) : null}
          {providers.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className={modelWrap} ref={wrapRef}>
        <label className={field}>
          <span>Model</span>
          <input
            ref={inputRef}
            className={`${inputStyle} ${input}`}
            value={value.model}
            placeholder="搜索或输入模型名"
            role="combobox"
            aria-expanded={hintsOpen}
            aria-haspopup="listbox"
            aria-controls={listId}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            onFocus={() => {
              if (skipOpenRef.current) {
                skipOpenRef.current = false
                return
              }
              if (modelHints.length > 0) openHints()
            }}
            onChange={(e) => {
              // 始终回传原始输入，允许列表外的自定义模型名（不合规则不清空）
              onChange({ ...value, model: e.target.value })
              setQuery(e.target.value)
              setHighlight(-1)
              if (modelHints.length > 0) setHintsOpen(true)
            }}
            onKeyDown={(e) => {
              if (modelHints.length === 0) return
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                if (!hintsOpen) {
                  openHints()
                  setHighlight(0)
                  return
                }
                const dir = e.key === 'ArrowDown' ? 1 : -1
                setHighlight((h) => {
                  if (h === -1) return dir === 1 ? 0 : visible.length - 1
                  return Math.min(visible.length - 1, Math.max(-1, h + dir))
                })
              } else if (e.key === 'Enter') {
                if (hintsOpen && highlight >= 0 && visible[highlight]) {
                  e.preventDefault()
                  pick(visible[highlight])
                }
              } else if (e.key === 'Escape') {
                if (hintsOpen) {
                  e.preventDefault()
                  closeHints()
                }
              }
            }}
            data-testid="model-input"
          />
        </label>
        {modelHints.length > 0 && (
          <button
            type="button"
            className={`${inputStyle} ${dropdownBtn}`}
            onClick={() => (hintsOpen ? closeHints() : openHints())}
            aria-label="展开模型列表"
            aria-haspopup="listbox"
            aria-expanded={hintsOpen}
            data-testid="model-dropdown"
          >
            ▾
          </button>
        )}
        {hintsOpen && modelHints.length > 0 && (
          <div
            className={hintList}
            role="listbox"
            id={listId}
            ref={listRef}
            data-testid="model-hints"
          >
            {visible.length === 0 ? (
              <div className={hintEmpty} data-testid="model-hints-empty">
                无匹配模型，将使用输入值
              </div>
            ) : (
              visible.map((m, i) => (
                <button
                  key={m}
                  type="button"
                  role="option"
                  aria-selected={m === value.model}
                  data-idx={i}
                  className={[
                    hintItem,
                    i === highlight ? hintItemHighlight : '',
                    m === value.model ? hintItemActive : '',
                  ].join(' ')}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(m)}
                  data-testid="model-hint"
                >
                  {m}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </>
  )
}
