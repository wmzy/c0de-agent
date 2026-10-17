import { css } from '@linaria/core'
import type { ModelOverride, ProviderConfig, ProviderProtocol } from '@shared/types/llm.js'
import { useQuery } from '@tanstack/react-query'
import { Button } from 'haze-ui'
import { useMemo, useState } from 'react'
import { Dialog } from '@/components/Dialog.js'
import { SyncedInput } from '@/components/SyncedControls.js'
import type { CatalogModel, CatalogProvider } from '@/services/catalog.js'
import { catalogAPI } from '@/services/catalog.js'

/** 失败原因取服务端 message（APIError）或 Error.message，与设置页其余面板同口径。 */
function messageOf(e: unknown): string {
  return (e as { message?: string } | null)?.message ?? (e instanceof Error ? e.message : String(e))
}

const searchBar = css`
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  font-size: 13px;
  &:focus {
    outline: none;
    border-color: var(--haze-color-primary);
  }
`

const listContainer = css`
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
`

const providerItem = css`
  width: 100%;
  padding: 10px 12px;
  border: none;
  border-bottom: 1px solid var(--haze-color-border);
  background: transparent;
  color: var(--haze-color-text);
  cursor: pointer;
  text-align: left;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  &:hover {
    background: var(--haze-color-bg-subtle);
  }
`

const providerItemSelected = css`
  background: var(--haze-color-bg-subtle);
`

const providerName = css`
  font-weight: 500;
  font-size: 13px;
`

const providerMeta = css`
  font-size: 11px;
  color: var(--haze-color-text-secondary);
`

const modelCount = css`
  font-size: 11px;
  color: var(--haze-color-text-secondary);
  background: var(--haze-color-bg-subtle);
  padding: 2px 8px;
  border-radius: 10px;
`

const errorBox = css`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
  font-size: 12px;
  color: var(--haze-color-danger, #b3261e);
`

const actions = css`
  display: flex;
  gap: 8px;
  justify-content: flex-end;
`

const detailPanel = css`
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 8px;
`

const modelItem = css`
  padding: 6px 10px;
  margin-bottom: 4px;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: var(--haze-color-bg-subtle);
  font-size: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
`

const modelName = css`
  font-weight: 500;
`

const modelTags = css`
  display: flex;
  gap: 4px;
`

const modelTag = css`
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  border: 1px solid var(--haze-color-border);
  color: var(--haze-color-text-secondary);
`

const modelTagActive = css`
  border-color: var(--haze-color-primary);
  color: var(--haze-color-primary);
`

const sourceLink = css`
  font-size: 11px;
  color: var(--haze-color-primary);
  text-decoration: none;
  &:hover {
    text-decoration: underline;
  }
`

const catalogBody = css`
  display: flex;
  gap: 8px;
  flex: 1;
  min-height: 0;
`

const listFixed = css`
  flex: 0 0 240px;
`

const catalogHint = css`
  padding: 12px;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
`

const catalogItemHead = css`
  margin-bottom: 8px;
`

/** 「选中项被搜索过滤掉但仍有效」的说明行。 */
const keptSelection = css`
  margin-top: 6px;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
`

/** 根据 models.dev 的 npm 字段推断 protocol。 */
function npmToProtocol(npm?: string): ProviderProtocol {
  if (!npm) return 'openai-compat'
  if (npm.includes('anthropic')) return 'anthropic'
  if (npm.includes('google')) return 'google'
  if (npm === '@ai-sdk/openai') return 'openai'
  return 'openai-compat'
}

/** 把 models.dev 的 CatalogModel 映射为 ModelOverride（capabilities 供 registry 使用）。
 *  models.dev cost 单位是 $/1M tokens，转换为 costPer1k（$/1k tokens）。 */
function toModelOverride(m: CatalogModel): ModelOverride {
  return {
    ...(m.context > 0 ? { contextWindow: m.context } : {}),
    ...(m.output > 0 ? { maxOutput: m.output } : {}),
    supportsTools: m.toolCall,
    supportsVision: m.attachment,
    supportsThinking: m.reasoning,
    ...(m.costInput != null ? { costPer1kInput: m.costInput / 1000 } : {}),
    ...(m.costOutput != null ? { costPer1kOutput: m.costOutput / 1000 } : {}),
  }
}

/** 把选中的 catalog provider 转成 ProviderConfig，附带模型 capabilities。 */
function toProviderConfig(p: CatalogProvider, models: CatalogModel[]): ProviderConfig {
  const config: ProviderConfig = {
    name: p.name,
    protocol: npmToProtocol(p.npm),
    baseURL: p.api ?? '',
    apiKey: '',
  }
  if (models.length > 0) {
    config.models = Object.fromEntries(models.map((m) => [m.id, toModelOverride(m)] as const))
  }
  return config
}

type ProviderCatalogDialogProps = {
  onClose: () => void
  /** 选中 provider 后回调（通常用于追加到 config.providers）。 */
  onSelect: (provider: ProviderConfig) => void
}

/** 「从 models.dev 目录选择 Provider」弹窗。 */
export function ProviderCatalogDialog({ onClose, onSelect }: ProviderCatalogDialogProps) {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const {
    data: providersData,
    isLoading: providersLoading,
    isError: providersError,
    error: providersErr,
    refetch: refetchProviders,
  } = useQuery({
    queryKey: ['catalog', 'providers'],
    queryFn: () => catalogAPI.listProviders(),
    retry: false,
  })

  const {
    data: modelsData,
    isLoading: modelsLoading,
    isError: modelsError,
    error: modelsErr,
    refetch: refetchModels,
  } = useQuery({
    queryKey: ['catalog', 'providers', selectedId, 'models'],
    queryFn: () => catalogAPI.getProviderModels(selectedId ?? ''),
    enabled: !!selectedId,
    retry: false,
  })

  const filtered = useMemo(() => {
    if (!providersData) return []
    const providers = providersData.providers
    if (!query.trim()) return providers
    const lower = query.toLowerCase()
    return providers.filter(
      (p) => p.name.toLowerCase().includes(lower) || p.id.toLowerCase().includes(lower),
    )
  }, [providersData, query])

  // 选中项从**完整列表**解析，而不是从搜索过滤后的列表：否则输入一个不包含它的
  // 搜索词就把选中态静默作废——底部「选择此 Provider」无声禁用、右侧详情标题从
  // Provider 名退化成裸 id、API/文档链接整块消失，而右侧内容还停留在旧 Provider 的
  // 模型列表上，用户只会以为是自己没选中。搜索是「看什么」，选择是「要什么」，两者独立。
  const selectedProvider = providersData?.providers.find((p) => p.id === selectedId) ?? null

  const handleSelect = () => {
    if (!selectedProvider) return
    // 模型清单读失败时不能按「零个模型」落盘：toProviderConfig 只在 models.length>0
    // 时写 models 字段，于是会追加一个没有任何模型/capabilities/定价的 Provider——
    // 用户以为「已按目录配置好」，实际这个 Provider 下什么都选不了、也无法补全。
    // 失败必须挡住确认键并给出原因，而不是静默写进配置。
    if (modelsError) return
    // 同理，**加载中**也不能落盘：模型清单还在飞时 modelsData 尚未到达，`?? []`
    // 会把它当成「零个模型」，落一个空 capabilities 的 Provider。失败态已挡，加载
    // 这一窗口此前没挡——右手边还在显示「加载模型列表…」，点确认就写进配置。
    if (modelsLoading || !modelsData) return
    onSelect(toProviderConfig(selectedProvider, modelsData.models))
    onClose()
  }

  return (
    <Dialog
      onClose={onClose}
      title="从 models.dev 目录选择 Provider"
      width="min(720px, 92vw)"
      testId="provider-catalog-dialog"
      footer={
        <div className={actions}>
          <Button onClick={onClose} variant="outline">
            取消
          </Button>
          <Button
            onClick={handleSelect}
            disabled={!selectedProvider || modelsError || modelsLoading || !modelsData}
            data-testid="catalog-confirm"
            variant="outline"
          >
            选择此 Provider
          </Button>
        </div>
      }
    >
      <SyncedInput
        className={searchBar}
        value={query}
        onChange={(v) => setQuery(v)}
        placeholder="搜索 Provider 名称…"
        data-testid="catalog-search"
      />
      {selectedProvider && !filtered.some((p) => p.id === selectedId) ? (
        // 选中项被当前搜索词过滤掉时，列表里找不到它，但选择仍然有效——不说明的话
        // 用户看到「确认」还是可点的会困惑「我到底选了什么」。
        <div className={keptSelection} data-testid="catalog-kept-selection">
          {`已选择「${selectedProvider.name}」，不受当前搜索影响`}
        </div>
      ) : null}
      <div className={catalogBody}>
        <div className={`${listContainer} ${listFixed}`}>
          {providersLoading ? (
            <div className={catalogHint}>加载中…</div>
          ) : providersError ? (
            // 目录读失败此前渲染成 filtered.length===0 的「没有匹配「」的 Provider」——
            // 把一次网络/500 失败说成「你搜的 Provider 不存在」，用户改搜索词、
            // 重开弹窗都找不到原因。此处与设置页其余面板同口径：原因 + 重试。
            <div className={errorBox} role="alert" data-testid="catalog-providers-error">
              <div>{`Provider 目录加载失败：${messageOf(providersErr)}`}</div>
              <Button variant="outline" onClick={() => void refetchProviders()}>
                重试
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            // 搜索无命中此前是一片空白，与「加载中…」视觉上无从区分，用户得不到
            // 「确实没有这个 Provider」的反馈。
            <div className={catalogHint} data-testid="catalog-no-match">
              {`没有匹配「${query.trim()}」的 Provider`}
            </div>
          ) : (
            filtered.map((p) => (
              <button
                key={p.id}
                type="button"
                className={
                  p.id === selectedId ? `${providerItem} ${providerItemSelected}` : providerItem
                }
                onClick={() => setSelectedId(p.id)}
                data-testid={`catalog-provider-${p.id}`}
              >
                <div>
                  <div className={providerName}>{p.name}</div>
                  <div className={providerMeta}>
                    {p.npm ?? p.id} · {p.env[0] ?? ''}
                  </div>
                </div>
                <span className={modelCount}>{p.modelCount}</span>
              </button>
            ))
          )}
        </div>
        <div className={detailPanel}>
          {!selectedId ? (
            <div className={catalogHint}>从左侧选择 Provider 查看可用模型</div>
          ) : modelsLoading ? (
            <div className={catalogHint}>加载模型列表…</div>
          ) : modelsError ? (
            // 模型清单读失败此前渲染成「Provider 头部照常显示 + 模型区一片空白」，
            // 且底部「选择此 Provider」仍可点——点了就把零模型的 Provider 写进配置。
            <div className={errorBox} role="alert" data-testid="catalog-models-error">
              <div>{`模型列表加载失败：${messageOf(modelsErr)}`}</div>
              <Button variant="outline" onClick={() => void refetchModels()}>
                重试
              </Button>
            </div>
          ) : (
            <>
              <div className={catalogItemHead}>
                <strong>{selectedProvider?.name ?? selectedId}</strong>
                {selectedProvider?.api ? (
                  <div className={providerMeta}>API: {selectedProvider.api}</div>
                ) : null}
                {selectedProvider?.doc ? (
                  <a
                    className={sourceLink}
                    href={selectedProvider.doc}
                    target="_blank"
                    rel="noreferrer"
                  >
                    文档 ↗
                  </a>
                ) : null}
              </div>
              {modelsData?.models.map((m) => (
                <div key={m.id} className={modelItem}>
                  <div>
                    <div className={modelName}>{m.name}</div>
                    <div className={providerMeta}>{m.id}</div>
                  </div>
                  <div className={modelTags}>
                    {m.reasoning ? (
                      <span className={`${modelTag} ${modelTagActive}`}>推理</span>
                    ) : null}
                    {m.toolCall ? (
                      <span className={`${modelTag} ${modelTagActive}`}>工具</span>
                    ) : null}
                    {m.attachment ? (
                      <span className={`${modelTag} ${modelTagActive}`}>多模态</span>
                    ) : null}
                    <span className={modelTag}>{(m.context / 1000).toFixed(0)}K ctx</span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </Dialog>
  )
}

export type { ProviderCatalogDialogProps }
