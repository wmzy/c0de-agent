import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useConfig } from '../contexts/ConfigContext.js'
import { providerAPI } from '../services/provider.js'

const field = css`
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
`

/** 基础控件样式。注意：wyw-in-js 不会把 `${control}` 的样式内联进派生类，
 * 派生类只生成增量；故每个控件需自包含 min-height，否则被全局 select/input{min-height:44px} 覆盖。 */
const selectControl = css`
  padding: 4px 28px 4px 8px;
  min-height: 28px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
`

const input = css`
  padding: 4px 8px;
  min-width: 180px;
  min-height: 28px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
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
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  border-left: none;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
`

const hintList = css`
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 10;
  margin-top: 2px;
  min-width: 180px;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
`

const hintItem = css`
  padding: 4px 8px;
  font: inherit;
  font-size: 12px;
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  cursor: pointer;
  &:hover {
    background: var(--bg-secondary);
  }
`

export type ModelSelection = { provider: string; model: string }

/** 输入框上方的 Provider + Model 切换器。
 * provider 来自已配置列表（/api/providers），model 为可编辑输入，
 * 建议项取自该 provider 在 config 中预定义的 models。
 *
 * 注意：不用原生 <datalist>——它在 input 有值时会按该值过滤选项，
 * 导致已填入 defaultModel 时只显示 1 个匹配项。改用自定义弹出列表，
 * 始终展示全部启用模型，不受 input 当前值影响。 */
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
  const modelHints = current?.models
    ? Object.entries(current.models)
        .filter(([, v]) => v.enabled !== false)
        .map(([name]) => name)
    : []

  const [hintsOpen, setHintsOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭弹出列表
  useEffect(() => {
    if (!hintsOpen) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setHintsOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [hintsOpen])

  const pick = (m: string) => {
    onChange({ ...value, model: m })
    setHintsOpen(false)
  }

  return (
    <>
      <label className={field}>
        <span>Provider</span>
        <select
          className={selectControl}
          value={value.provider}
          onChange={(e) => onChange({ ...value, provider: e.target.value })}
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
            className={input}
            value={value.model}
            placeholder="模型名"
            onFocus={() => modelHints.length > 0 && setHintsOpen(true)}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
            data-testid="model-input"
          />
        </label>
        {modelHints.length > 0 && (
          <button
            type="button"
            className={dropdownBtn}
            onClick={() => setHintsOpen((o) => !o)}
            aria-label="切换模型"
            aria-expanded={hintsOpen}
            data-testid="model-dropdown"
          >
            ▾
          </button>
        )}
        {hintsOpen && modelHints.length > 0 && (
          <div className={hintList} role="listbox" data-testid="model-hints">
            {modelHints.map((m) => (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={m === value.model}
                className={hintItem}
                onClick={() => pick(m)}
                data-testid={`model-hint`}
              >
                {m}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
