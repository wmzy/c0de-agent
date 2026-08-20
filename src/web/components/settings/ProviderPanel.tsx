import { css } from '@linaria/core'
import type { ModelOverride, ProviderConfig } from '@shared/types/llm.js'
import { useState } from 'react'
import type { TestResult } from '../../services/provider.js'
import { providerAPI } from '../../services/provider.js'
import { MOBILE } from '../../styles/breakpoints.js'
import { ProviderCatalogDialog } from '../ProviderCatalogDialog.js'
import { ApiKeyInput } from './ApiKeyInput.js'
import { ProviderModelsPanel } from './ModelPanel.js'
import { section, sectionTitle } from './styles.js'

/*
 * Provider 行网格：桌面 6 列（名称/协议/URL/APIKey + 测试/删除），窄屏 2 列堆叠。
 * 关键：1fr 轨道的 min 宽默认是 auto（= 输入框固有 ~170px），4 列合计即 ~700px+，
 * 是窄屏横向滚动的根因；providerField 上 min-width:0 允许列内收缩消除溢出。
 */
const providerRow = css`
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr auto auto;
  gap: 8px;
  align-items: end;
  padding: 10px;
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
  ${MOBILE} {
    /* 窄屏：6 列改 2 列；长字段（URL/API Key）由 providerFieldWide 整行展开 */
    grid-template-columns: 1fr 1fr;
  }
`

/** 字段单元：小标签悬于控件上方；min-width:0 让 1fr 列可收缩防横向溢出。 */
const providerField = css`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;

  & input,
  & select {
    width: 100%;
    min-width: 0;
  }
`

/** 字段标签：小号次级色（名称/协议/URL/API Key）。 */
const providerFieldLabel = css`
  font-size: 12px;
  color: var(--text-secondary);
`

/** 窄屏整行字段：URL / API Key 输入较长，独占一行。 */
const providerFieldWide = css`
  ${MOBILE} {
    grid-column: 1 / -1;
  }
`

const testResultSpan = css`
  grid-column: 1 / -1;
  font-size: 0.85em;
`

/** 测试结果 — 成功色。 */
const testOk = css`
  color: var(--success);
`

/** 测试结果 — 错误色。 */
const testErr = css`
  color: var(--error);
`

const buttonRow = css`
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
`

const sourceHint = css`
  font-size: 12px;
  color: var(--text-secondary);
`

const sourceLink = css`
  color: var(--primary);
  text-decoration: none;
  &:hover {
    text-decoration: underline;
  }
`

interface ProviderPanelProps {
  providers: ProviderConfig[]
  /**
   * 以函数式更新应用 provider 变更：Settings 在 setDraft 内对最新 draft.providers
   * 执行 updater，保证测试连接（异步）返回时不会因闭包持有旧 providers 而丢弃并发编辑。
   */
  onProvidersChange: (updater: (providers: ProviderConfig[]) => ProviderConfig[]) => void
}

/**
 * LLM Provider 管理面板：列表、手动添加 / 从 models.dev 选择、编辑字段、
 * 测试连接（探测模型并回写）、删除，以及每个 provider 的模型 override 子面板。
 */
function ProviderPanel({ providers, onProvidersChange }: ProviderPanelProps) {
  const [testResults, setTestResults] = useState<
    Record<number, { loading: boolean; result?: TestResult }>
  >({})
  const [catalogOpen, setCatalogOpen] = useState(false)

  const addProviderFromCatalog = (provider: ProviderConfig) => {
    onProvidersChange((prev) => [...prev, provider])
  }

  const addProvider = () => {
    const newProvider: ProviderConfig = {
      name: '',
      protocol: 'openai-compat',
      apiKey: '',
      baseURL: '',
    }
    onProvidersChange((prev) => [...prev, newProvider])
  }

  const removeProvider = (index: number) => {
    onProvidersChange((prev) => prev.filter((_, i) => i !== index))
  }

  const updateProvider = (index: number, field: keyof ProviderConfig, value: string) => {
    onProvidersChange((prev) => prev.map((p, i) => (i === index ? { ...p, [field]: value } : p)))
  }

  /** 对某 provider 的 models 做任意变换，写回 draft。 */
  const updateModels = (
    providerIndex: number,
    fn: (models: Record<string, ModelOverride>) => Record<string, ModelOverride>,
  ) => {
    onProvidersChange((prev) =>
      prev.map((p, i) => (i === providerIndex ? { ...p, models: fn(p.models ?? {}) } : p)),
    )
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

  /** 更新单个模型的 capability 字段（contextWindow/maxOutput 等）。 */
  const updateModelField = (
    providerIndex: number,
    modelName: string,
    patch: Partial<ModelOverride>,
  ) => {
    updateModels(providerIndex, (models) => ({
      ...models,
      [modelName]: { ...(models[modelName] ?? {}), ...patch },
    }))
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
        onProvidersChange((prev) =>
          prev.map((p, i) => {
            if (i !== index) return p
            const existing = p.models ?? {}
            const next = { ...existing }
            for (const m of detected) {
              if (!(m in next)) next[m] = {}
            }
            return { ...p, models: next }
          }),
        )
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
    <div className={section}>
      <h2 className={sectionTitle}>LLM Provider</h2>
      {providers.map((provider, index) => {
        const test = testResults[index]
        return (
          <div
            // key 必须稳定：若依赖 name/baseURL，输入首字符即改变 key
            // 导致该行卸载重建、输入框失焦。用 index 即可（受控表单列表）。
            // biome-ignore lint/suspicious/noArrayIndexKey: 受控表单列表，name 输入会改 key 导致重挂载失焦
            key={index}
            className={providerRow}
            data-testid="provider-row"
          >
            <div className={providerField}>
              <label className={providerFieldLabel} htmlFor={`provider-name-${index}`}>
                名称
              </label>
              <input
                id={`provider-name-${index}`}
                value={provider.name}
                onChange={(e) => updateProvider(index, 'name', e.target.value)}
                placeholder="名称"
              />
            </div>
            <div className={providerField}>
              <label className={providerFieldLabel} htmlFor={`provider-protocol-${index}`}>
                协议
              </label>
              <select
                id={`provider-protocol-${index}`}
                value={provider.protocol}
                onChange={(e) => updateProvider(index, 'protocol', e.target.value)}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google</option>
                <option value="openai-compat">OpenAI Compatible</option>
              </select>
            </div>
            <div className={`${providerField} ${providerFieldWide}`}>
              <label className={providerFieldLabel} htmlFor={`provider-url-${index}`}>
                URL
              </label>
              <input
                id={`provider-url-${index}`}
                value={provider.baseURL ?? ''}
                onChange={(e) => updateProvider(index, 'baseURL', e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div className={`${providerField} ${providerFieldWide}`}>
              <label className={providerFieldLabel} htmlFor={`provider-apikey-${index}`}>
                API Key
              </label>
              <ApiKeyInput
                id={`provider-apikey-${index}`}
                stored={provider.apiKey}
                onCommit={(value) => updateProvider(index, 'apiKey', value)}
              />
            </div>
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
              data-variant="danger"
              onClick={() => removeProvider(index)}
              data-testid="provider-remove"
            >
              删除
            </button>
            {test?.result && (
              <span className={`${testResultSpan} ${test.result.ok ? testOk : testErr}`}>
                {test.result.ok
                  ? `\u2713 连接成功，${test.result.models.length} 个模型`
                  : `\u2717 ${test.result.error}`}
              </span>
            )}
            <ProviderModelsPanel
              models={provider.models ?? {}}
              onToggle={(name) => toggleModel(index, name)}
              onSetAll={(enabled) => setAllModels(index, enabled)}
              onModelFieldChange={(name, patch) => updateModelField(index, name, patch)}
            />
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
  )
}

export { ProviderPanel }
