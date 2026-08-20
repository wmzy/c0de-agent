import { css } from '@linaria/core'
import type { ModelOverride, ProviderConfig } from '@shared/types/llm.js'
import { useState } from 'react'
import { inputStyle } from '../../styles/tokens.js'
import { enabledModelsOf, providerCandidates } from './shared.js'
import { field, fieldInput, mutedHint, section, sectionTitle } from './styles.js'

const modelPanel = css`
  grid-column: 1 / -1;
  margin-top: 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  padding: 8px;
`

const modelToolbar = css`
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
  flex-wrap: wrap;
`

const modelFilterInput = css`
  flex: 1;
  min-width: 120px;
  padding: 3px 6px;
  font-size: 12px;
`

const modelToolbarBtn = css`
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text);
  font-size: 11px;
  cursor: pointer;
`

const modelCountText = css`
  font-size: 11px;
  color: var(--text-secondary);
`

const modelList = css`
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 160px;
  overflow-y: auto;
`

const modelRow = css`
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  padding: 4px;
  border-bottom: 1px solid var(--border);
`

const modelCapRow = css`
  display: flex;
  gap: 12px;
  padding-left: 22px;
  flex-wrap: wrap;
`

const modelCapField = css`
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-secondary);
`

const modelCapInput = css`
  width: 90px;
  padding: 2px 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg);
  color: var(--text);
  font-size: 11px;
`

const modelEmpty = css`
  font-size: 12px;
  color: var(--text-secondary);
  padding: 4px;
`

interface ModelPanelProps {
  providers: ProviderConfig[]
  defaultProvider: string
  defaultModel: string
  onChange: (patch: { defaultProvider?: string; defaultModel?: string }) => void
}

/**
 * 默认 Provider / Model 选择。
 *
 * 候选项来自已配置 provider 及其已启用模型（仅启用的）。切换默认 provider 时，
 * 若当前 model 不属于新 provider 的启用模型，则校正为其首个启用模型。
 */
function ModelPanel({ providers, defaultProvider, defaultModel, onChange }: ModelPanelProps) {
  // 默认 Provider/Model 候选来自已配置 provider 及其 models（仅启用的）。
  // defaultProvider 可能是 protocol 名或导入的陌生值，不在已配置列表时由 select 兜底显示。
  const defaultProviderCandidates = providerCandidates(providers)
  const defaultProviderEntry = defaultProviderCandidates.find((p) => p.name === defaultProvider)
  const defaultModelCandidates = defaultProviderEntry
    ? Object.entries(defaultProviderEntry.models ?? {})
        .filter(([, v]) => v.enabled !== false)
        .map(([name]) => name)
    : []

  // 切换默认 provider 时校正 model：新 provider 不含当前 model 则取首个启用模型。
  const changeDefaultProvider = (name: string) => {
    const models = enabledModelsOf(providers, name)
    const keepModel = models.includes(defaultModel)
    onChange({
      defaultProvider: name,
      defaultModel: keepModel ? defaultModel : (models[0] ?? ''),
    })
  }

  return (
    <div className={section}>
      <h2 className={sectionTitle}>默认 Provider / Model</h2>
      {defaultProviderCandidates.length === 0 ? (
        <p className={mutedHint}>请先在上方「LLM Provider」添加并配置 Provider，再选择默认值。</p>
      ) : (
        <>
          <label className={field}>
            <span>Provider：</span>
            <select
              className={fieldInput}
              value={defaultProvider}
              onChange={(e) => changeDefaultProvider(e.target.value)}
              data-testid="default-provider-select"
            >
              {/* 当前值不在已配置列表时兜底显示，避免受控 select 丢失值 */}
              {!defaultProviderCandidates.some((p) => p.name === defaultProvider) &&
              defaultProvider ? (
                <option value={defaultProvider}>{defaultProvider}（未配置）</option>
              ) : null}
              {defaultProviderCandidates.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            <span>Model：</span>
            <select
              className={fieldInput}
              value={defaultModel}
              onChange={(e) => onChange({ defaultModel: e.target.value })}
              data-testid="default-model-select"
            >
              {defaultModelCandidates.length === 0 ? (
                <option value="">
                  {defaultProviderEntry ? '该 Provider 暂无模型，请先添加' : '请先选择 Provider'}
                </option>
              ) : null}
              {!defaultModelCandidates.includes(defaultModel) && defaultModel ? (
                <option value={defaultModel}>{defaultModel}（未配置）</option>
              ) : null}
              {defaultModelCandidates.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  )
}

interface ProviderModelsPanelProps {
  models: Record<string, ModelOverride>
  onToggle: (modelName: string) => void
  onSetAll: (enabled: boolean) => void
  onModelFieldChange: (modelName: string, patch: Partial<ModelOverride>) => void
}

/**
 * 单个 provider 的模型 override 列表（展示/过滤/启禁）。
 *
 * 渲染在 ProviderPanel 的每一行内：勾选即写入该模型的 enabled 状态（ModelOverride）。
 * 过滤缓冲为组件内部状态（按 provider 实例隔离）。
 */
function ProviderModelsPanel({
  models,
  onToggle,
  onSetAll,
  onModelFieldChange,
}: ProviderModelsPanelProps) {
  const [filter, setFilter] = useState('')
  const modelEntries = Object.entries(models)
  const totalCount = modelEntries.length
  const enabledCount = modelEntries.filter(([, v]) => v.enabled !== false).length
  const filterText = filter.toLowerCase()
  const filteredModels = filterText
    ? modelEntries.filter(([name]) => name.toLowerCase().includes(filterText))
    : modelEntries
  if (totalCount === 0) return null
  return (
    <div className={modelPanel} data-testid="provider-models">
      <div className={modelToolbar}>
        <input
          className={`${inputStyle} ${modelFilterInput}`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="过滤模型…"
          data-testid="provider-model-filter"
        />
        <button
          type="button"
          className={modelToolbarBtn}
          onClick={() => onSetAll(true)}
          data-testid="provider-models-enable-all"
        >
          启用所有
        </button>
        <button
          type="button"
          className={modelToolbarBtn}
          onClick={() => onSetAll(false)}
          data-testid="provider-models-disable-all"
        >
          禁用所有
        </button>
        <span className={modelCountText} data-testid="provider-models-count">
          {enabledCount} / {totalCount} 已启用
        </span>
      </div>
      <div className={modelList}>
        {filteredModels.length === 0 ? (
          <div className={modelEmpty}>无匹配模型</div>
        ) : (
          filteredModels.map(([name, override]) => {
            const on = override.enabled !== false
            return (
              <div key={name} className={modelRow}>
                <label>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => onToggle(name)}
                    data-testid={`provider-model-toggle-${name}`}
                  />
                  <span>{name}</span>
                </label>
                <div className={modelCapRow}>
                  <label className={modelCapField}>
                    <span>上下文窗口</span>
                    <input
                      type="number"
                      className={modelCapInput}
                      value={override.contextWindow ?? ''}
                      onChange={(e) =>
                        onModelFieldChange(name, {
                          contextWindow: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                      placeholder="留空=默认"
                      min={1000}
                      data-testid={`model-ctx-${name}`}
                    />
                  </label>
                  <label className={modelCapField}>
                    <span>最大输出</span>
                    <input
                      type="number"
                      className={modelCapInput}
                      value={override.maxOutput ?? ''}
                      onChange={(e) =>
                        onModelFieldChange(name, {
                          maxOutput: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                      placeholder="留空=默认"
                      min={256}
                      data-testid={`model-output-${name}`}
                    />
                  </label>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export { ModelPanel, ProviderModelsPanel }
