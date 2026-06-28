import { css } from '@linaria/core'
import type { Config } from '@shared/types/config.js'
import type { ModelOverride, ProviderConfig } from '@shared/types/llm.js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ProviderCatalogDialog } from '../components/ProviderCatalogDialog.js'
import { useTheme } from '../contexts/ThemeContext.js'
import { configAPI } from '../services/config.js'
import type { TestResult } from '../services/provider.js'
import { providerAPI } from '../services/provider.js'

const section = css`
  padding: 16px;
  border-bottom: 1px solid var(--border);
`

const providerRow = css`
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr auto auto;
  gap: 8px;
  align-items: center;
  padding: 10px;
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
`

const testResultSpan = css`
  grid-column: 1 / -1;
  font-size: 0.85em;
`

const buttonRow = css`
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
`

const sourceHint = css`
  font-size: 11px;
  color: var(--text-secondary);
`

const sourceLink = css`
  color: var(--primary);
  text-decoration: none;
  &:hover {
    text-decoration: underline;
  }
`

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
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
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
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 2px 4px;
`

const modelEmpty = css`
  font-size: 12px;
  color: var(--text-secondary);
  padding: 4px;
`

export function Settings() {
  const qc = useQueryClient()
  const { data: config, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => configAPI.get(),
  })
  const { mode, setMode } = useTheme()
  const [draft, setDraft] = useState<Partial<Config> | null>(null)
  const [testResults, setTestResults] = useState<
    Record<number, { loading: boolean; result?: TestResult }>
  >({})
  const [modelFilter, setModelFilter] = useState<Record<number, string>>({})
  const [catalogOpen, setCatalogOpen] = useState(false)

  const save = useMutation({
    mutationFn: (patch: Partial<Config>) => configAPI.update(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
  })

  const addProviderFromCatalog = (provider: ProviderConfig) => {
    updateProviders([...merged.providers, provider])
  }

  if (isLoading || !config) return <div style={{ padding: 24 }}>加载中…</div>

  const merged = { ...config, ...draft }

  const updateProviders = (providers: ProviderConfig[]) => {
    setDraft((prev) => ({ ...prev, providers }))
  }

  const addProvider = () => {
    const newProvider: ProviderConfig = {
      name: '',
      protocol: 'openai-compat',
      apiKey: '',
      baseURL: '',
    }
    updateProviders([...merged.providers, newProvider])
  }

  const removeProvider = (index: number) => {
    const newProviders = merged.providers.filter((_, i) => i !== index)
    updateProviders(newProviders)
  }

  const updateProvider = (index: number, field: keyof ProviderConfig, value: string) => {
    const newProviders = merged.providers.map((p, i) =>
      i === index ? { ...p, [field]: value } : p,
    )
    updateProviders(newProviders)
  }

  /** 对某 provider 的 models 做任意变换，写回 draft。 */
  const updateModels = (
    providerIndex: number,
    fn: (models: Record<string, ModelOverride>) => Record<string, ModelOverride>,
  ) => {
    setDraft((prev) => {
      const base = prev ?? config
      const providers = (base.providers ?? []).map((p, i) =>
        i === providerIndex ? { ...p, models: fn(p.models ?? {}) } : p,
      )
      return { ...base, providers }
    })
  }

  /** 切换单个模型的启用状态。 */
  const toggleModel = (providerIndex: number, modelName: string) => {
    updateModels(providerIndex, (models) => {
      const next = { ...models }
      const cur = next[modelName] ?? {}
      next[modelName] = { ...cur, enabled: !(cur.enabled ?? true) }
      return next
    })
  }

  /** 全量启用/禁用该 provider 的所有模型。 */
  const setAllModels = (providerIndex: number, enabled: boolean) => {
    updateModels(providerIndex, (models) =>
      Object.fromEntries(Object.entries(models).map(([k, v]) => [k, { ...v, enabled }] as const)),
    )
  }

  const testProvider = async (index: number, baseURL: string, apiKey: string) => {
    setTestResults((prev) => ({ ...prev, [index]: { loading: true } }))
    try {
      const result = await providerAPI.test(baseURL, apiKey)
      setTestResults((prev) => ({ ...prev, [index]: { loading: false, result } }))
      // 测试成功时，把探测到的模型合并进 draft.providers[index].models，
      // 使保存后会话 ModelSelector 可选。保留 provider 已有的 ModelOverride，
      // 仅补全新检测到的模型。
      if (result.ok) {
        const detected = result.models
        setDraft((prev) => {
          const base = prev ?? config
          const providers = (base.providers ?? []).map((p, i) => {
            if (i !== index) return p
            const existing = p.models ?? {}
            const next = { ...existing }
            for (const m of detected) {
              if (!(m in next)) next[m] = {}
            }
            return { ...p, models: next }
          })
          return { ...base, providers }
        })
      }
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [index]: {
          loading: false,
          result: {
            ok: false,
            error: err instanceof Error ? err.message : '未知错误',
          },
        },
      }))
    }
  }

  return (
    <div data-testid="settings" style={{ overflow: 'auto' }}>
      <div className={section}>
        <h3>主题</h3>
        <select value={mode} onChange={(e) => setMode(e.target.value as never)}>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
          <option value="system">跟随系统</option>
        </select>
      </div>
      <div className={section}>
        <h3>默认 Provider / Model</h3>
        <label>
          Provider:
          <input
            value={merged.defaultProvider}
            onChange={(e) => setDraft((prev) => ({ ...prev, defaultProvider: e.target.value }))}
          />
        </label>
        <label>
          Model:
          <input
            value={merged.defaultModel}
            onChange={(e) => setDraft((prev) => ({ ...prev, defaultModel: e.target.value }))}
          />
        </label>
      </div>
      <div className={section}>
        <h3>LLM Provider</h3>
        {merged.providers.map((provider, index) => {
          const test = testResults[index]
          const modelEntries = Object.entries(provider.models ?? {})
          const totalCount = modelEntries.length
          const enabledCount = modelEntries.filter(([, v]) => v.enabled !== false).length
          const filterText = (modelFilter[index] ?? '').toLowerCase()
          const filteredModels = filterText
            ? modelEntries.filter(([name]) => name.toLowerCase().includes(filterText))
            : modelEntries
          return (
            <div
              key={`${provider.name || 'p'}-${provider.baseURL || 'b'}`}
              className={providerRow}
              data-testid="provider-row"
            >
              <input
                value={provider.name}
                onChange={(e) => updateProvider(index, 'name', e.target.value)}
                placeholder="名称"
              />
              <select
                value={provider.protocol}
                onChange={(e) => updateProvider(index, 'protocol', e.target.value)}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google</option>
                <option value="openai-compat">OpenAI Compatible</option>
              </select>
              <input
                value={provider.baseURL ?? ''}
                onChange={(e) => updateProvider(index, 'baseURL', e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
              <input
                type="password"
                value={provider.apiKey}
                onChange={(e) => updateProvider(index, 'apiKey', e.target.value)}
                placeholder="API Key"
              />
              <button
                type="button"
                onClick={() => testProvider(index, provider.baseURL ?? '', provider.apiKey)}
                disabled={test?.loading === true}
                data-testid="provider-test"
              >
                {test?.loading ? '测试中…' : '测试'}
              </button>
              <button
                type="button"
                onClick={() => removeProvider(index)}
                data-testid="provider-remove"
              >
                删除
              </button>
              {test?.result && (
                <span
                  className={testResultSpan}
                  style={{
                    color: test.result.ok ? 'var(--success)' : 'var(--error)',
                  }}
                >
                  {test.result.ok
                    ? `\u2713 连接成功，${test.result.models.length} 个模型`
                    : `\u2717 ${test.result.error}`}
                </span>
              )}
              {totalCount > 0 && (
                <div className={modelPanel} data-testid="provider-models">
                  <div className={modelToolbar}>
                    <input
                      className={modelFilterInput}
                      value={modelFilter[index] ?? ''}
                      onChange={(e) =>
                        setModelFilter((prev) => ({ ...prev, [index]: e.target.value }))
                      }
                      placeholder="过滤模型…"
                      data-testid="provider-model-filter"
                    />
                    <button
                      type="button"
                      className={modelToolbarBtn}
                      onClick={() => setAllModels(index, true)}
                      data-testid="provider-models-enable-all"
                    >
                      启用所有
                    </button>
                    <button
                      type="button"
                      className={modelToolbarBtn}
                      onClick={() => setAllModels(index, false)}
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
                          <label key={name} className={modelRow}>
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggleModel(index, name)}
                              data-testid={`provider-model-toggle-${name}`}
                            />
                            <span>{name}</span>
                          </label>
                        )
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
        <div className={buttonRow}>
          <button type="button" onClick={addProvider} data-testid="provider-add">
            + 手动添加
          </button>
          <button type="button" onClick={() => setCatalogOpen(true)} data-testid="provider-catalog">
            从 models.dev 选择
          </button>
          <span className={sourceHint}>
            数据源：
            <a className={sourceLink} href="https://models.dev" target="_blank" rel="noreferrer">
              models.dev
            </a>
          </span>
        </div>
        {catalogOpen && (
          <ProviderCatalogDialog
            onClose={() => setCatalogOpen(false)}
            onSelect={addProviderFromCatalog}
          />
        )}
      </div>
      <div className={section}>
        <h3>启用工具</h3>
        <input
          value={merged.tools.enabled.join(', ')}
          onChange={(e) =>
            setDraft((prev) => ({
              ...prev,
              tools: {
                ...merged.tools,
                enabled: e.target.value.split(',').map((s) => s.trim()),
              },
            }))
          }
        />
      </div>
      <div className={section}>
        <h3>压缩阈值</h3>
        <input
          type="number"
          step="0.05"
          value={merged.compaction.threshold}
          onChange={(e) =>
            setDraft((prev) => ({
              ...prev,
              compaction: {
                ...merged.compaction,
                threshold: Number(e.target.value),
              },
            }))
          }
        />
      </div>
      <div className={section}>
        <button
          type="button"
          onClick={() => draft && save.mutate(draft)}
          disabled={!draft}
          data-testid="settings-save"
        >
          保存
        </button>
      </div>
    </div>
  )
}
