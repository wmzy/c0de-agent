import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { SyncedInput, SyncedSelect } from '@/components/SyncedControls.js'
import { useConfig } from '@/contexts/ConfigContext.js'
import { providerAPI } from '@/services/provider.js'
import { compactSelect, inputStyle } from '@/styles/tokens.js'
import { isImeComposing } from '@/utils/ime.js'

const field = css`
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
  /* 极窄视口（<240px）放不下「标签 + 控件」时换行，避免整行撑出横向滚动
   * （WCAG 1.4.10 Reflow）。标签不参与收缩折行。 */
  flex-wrap: wrap;
  min-width: 0;
  /* 不被同排兄弟压缩到内容宽度以下：压缩会让控件掉到标签下一行（字段自己
   * 折行，底栏因此从 1 行涨到 3 行），更糟的是 label 与相邻字段重叠——
   * 实测底栏 636px 时 Provider 标签与 Model 标签重叠 3px，渲染成「ProvideModel」。
   * 宽度真不够时由 footerLeft 整字段换行（flex-wrap），而不是字段内部错行。
   * flex-wrap + min-width:0 保留：极窄视口（<240px）下仍能折行，不产生横向滚动。 */
  flex-shrink: 0;
  & > span:first-child {
    flex-shrink: 0;
  }
`

/** 基础控件增量样式见 tokens.compactSelect（含 width:auto 覆盖 haze 的 width:100%）。 */

const input = css`
  padding: 4px 8px;
  /* 窄屏（手机捏合放大后 CSS 视口可低至 ~200px）下可收缩：min-width 是可用的
   * 舒适宽度下限，不是硬下限，否则「Model 标签 + 180px 输入 + 下拉按钮」
   * 实测撑到 250px，产生横向滚动（WCAG 1.4.10 Reflow）。 */
  min-width: 0;
  width: 180px;
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
  /* 允许收缩，配合 input 的 min-width:0 一起让位给窄视口 */
  min-width: 0;
  /* 与 field 口径一致：宽度不足时整字段换行，而不是压缩到标签叠字。
     压缩在此无害（input 自带 ellipsis），但压缩会让 field 内部折行、
     底栏从 1 行涨到 3 行；交给 footerLeft 的 flex-wrap 换行更干净。 */
  flex-shrink: 1;
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
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  box-shadow: var(--haze-shadow-md, 0 4px 12px rgba(0, 0, 0, 0.15));
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
  color: var(--haze-color-text);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  &:hover {
    background: var(--haze-color-bg-subtle);
  }
`

/** 键盘/悬停高亮项。 */
const hintItemHighlight = css`
  background: var(--haze-color-bg-subtle);
`

/** 当前已选中的模型名。 */
const hintItemActive = css`
  color: var(--haze-color-primary);
  font-weight: 600;
`

/** 过滤无匹配时的空态提示。 */
const hintEmpty = css`
  padding: 6px 10px;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

/**
 * Provider 下拉的宽度下限。
 *
 * compactSelect 自适应（width:auto + min-width:0）是必要的——haze 的 SelectCore
 * 带 width:100%，在 flex 行里会吃掉全部剩余宽度、把同排兄弟压没。但完全自适应
 * 意味着栏宽紧张时它会被压到只剩内边距的宽度：实测底栏 636px 时 Provider 只剩
 * 38px，当前 provider 名一个字都显示不出来，用户无法确认这条会话在用哪个 provider。
 *
 * 90px 约能放下常见 provider 名（openai / anthropic / ollama）的主体部分，
 * 更长仍按 compactSelect 的省略号截断，绝不撑破容器。
 */
const providerMinWidth = css`
  min-width: 90px;
`

/**
 * 未配置任何 Provider 时的整行占位。
 *
 * 此前组件照常渲染：一个 options 为空、value 为空串的 Provider 下拉（视觉上
 * 是一个「点了没反应」的框），外加 Model 输入框里预填 config.defaultModel
 * ——而 defaultModel/defaultProvider 来自 DEFAULT_CONFIG（openai / gpt-4o），
 * 与用户实际配置毫无关系。实测未配置项目上：Provider 显示空白、Model 写着
 * 「gpt-4o」，用户会以为已经选好了模型，发送后才被后端拒绝，且报错是
 * 「未找到名为「」的 AI 服务」——那个空引号就是那个空下拉的值。
 *
 * 空状态下没有任何可选模型，渲染可交互控件没有意义：把两者整体换成一句
 * 明示「先去配置」的话，用户不必靠报错反推前置条件。
 */
const noProviderNotice = css`
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
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
  projectId,
}: {
  value: ModelSelection
  onChange: (v: ModelSelection) => void
  /** P1-1：按项目读取配置（模型建议/默认值来自该项目合并配置）。 */
  projectId?: string
}) {
  const { data } = useQuery({
    queryKey: ['providers', projectId],
    queryFn: () => providerAPI.list(projectId),
    staleTime: 60_000,
  })
  const { config } = useConfig(projectId)

  const providers = data?.providers ?? []
  const hasMatch = providers.some((p) => p.name === value.provider)

  // 当前 provider 在 config 中预定义的模型名（作为输入建议）
  const configured = config?.providers ?? []
  /** provider 在 config 中声明的「已启用模型」清单；未声明清单（自建网关等）返回
   *  undefined——用于区分「清单里没有这个模型」与「此 provider 不限定模型」。 */
  const declaredModelsFor = useCallback(
    (name: string): string[] | undefined => {
      const p = configured.find((x) => x.name === name)
      if (!p?.models) return undefined
      // 仅列出启用的模型（enabled 省略/true 视为启用）
      return Object.entries(p.models)
        .filter(([, v]) => v.enabled !== false)
        .map(([m]) => m)
    },
    [configured],
  )
  const modelHints = useMemo(
    () => declaredModelsFor(value.provider) ?? [],
    [declaredModelsFor, value.provider],
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

  const openHints = (opts?: { focusInput?: boolean }) => {
    setHintsOpen(true)
    setQuery(null)
    setHighlight(-1)
    // ▾ 按钮打开的列表归输入框管：焦点留在按钮上时 ↑↓/Enter/Esc 全部落空
    // （这些键只挂在 combobox 的 onKeyDown 上），列表等于对键盘不可用。
    if (opts?.focusInput) {
      skipOpenRef.current = true
      inputRef.current?.focus()
      queueMicrotask(() => {
        skipOpenRef.current = false
      })
    }
  }

  /** 收起列表：焦点仍在按钮上时留在原处，别把用户甩到别的控件上。 */
  const toggleHintsFromButton = () => {
    if (hintsOpen) {
      closeHints()
      return
    }
    openHints({ focusInput: true })
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
      {/* 未配置任何 Provider：providers 已加载且为空。此时没有可选项，
          照常渲染下拉与模型输入只会给出「假已选中」的错觉（见 noProviderNotice）。
          dataLoaded 用 data.data 是否到位区分「确实为空」与「还在加载」——
          加载中先不闪这句，避免每次进页面都闪一下「未配置」。 */}
      {providers.length === 0 && data ? (
        <span className={noProviderNotice} data-testid="model-selector-empty">
          未配置 AI 服务，先到「设置 → Provider」添加
        </span>
      ) : (
        <>
          <label className={field}>
            <span>Provider</span>
            <SyncedSelect
              className={`${inputStyle} ${compactSelect} ${providerMinWidth}`}
              value={value.provider}
              onValuesChange={(v) => {
                const next = v as string
                // 切换 provider 后旧模型名属于上一个 provider：新 provider 若声明了
                // 模型清单且当前值不在其中，校正为清单首项。不校正会发出「不存在的
                // provider+model 组合」——provider 下拉与 model 输入框都显示着值，
                // 界面看不出问题，只有请求失败（服务端 MODEL_NOT_FOUND）。
                // 未声明清单的 provider（自建网关）保持自由输入原值。
                const declared = declaredModelsFor(next) ?? []
                const model =
                  declared.length > 0 && !declared.includes(value.model)
                    ? (declared[0] ?? value.model)
                    : value.model
                onChange({ provider: next, model })
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
            </SyncedSelect>
          </label>
          <div className={modelWrap} ref={wrapRef}>
            <label className={field}>
              <span>Model</span>
              <SyncedInput
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
                onChange={(v) => {
                  // 始终回传原始输入，允许列表外的自定义模型名（不合规则不清空）
                  onChange({ ...value, model: v })
                  setQuery(v)
                  setHighlight(-1)
                  if (modelHints.length > 0) setHintsOpen(true)
                }}
                onKeyDown={(e) => {
                  // IME 组合中不拦截：回车确认候选词/方向键选候选由输入法处理——
                  // 不判定会在候选未确认时移动提示选中项或确认模型。
                  if (isImeComposing(e)) return
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
                onClick={toggleHintsFromButton}
                aria-label={hintsOpen ? '收起模型列表' : '展开模型列表'}
                aria-haspopup="listbox"
                aria-expanded={hintsOpen}
                aria-controls={listId}
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
      )}
    </>
  )
}
