import { css } from '@linaria/core'
import type { ProviderConfig, ProviderProtocol } from '@shared/types/llm.js'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type { CatalogProvider } from '../services/catalog.js'
import { catalogAPI } from '../services/catalog.js'

const overlay = css`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
`

const dialog = css`
  background: var(--bg);
  border-radius: 8px;
  padding: 20px;
  width: min(720px, 92vw);
  max-height: 80vh;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 12px;
`

const title = css`
  font-size: 16px;
  font-weight: 600;
`

const searchBar = css`
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  &:focus {
    outline: none;
    border-color: var(--primary);
  }
`

const listContainer = css`
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
`

const providerItem = css`
  width: 100%;
  padding: 10px 12px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  &:hover {
    background: var(--bg-secondary);
  }
`

const providerItemSelected = css`
  background: var(--bg-secondary);
`

const providerName = css`
  font-weight: 500;
  font-size: 13px;
`

const providerMeta = css`
  font-size: 11px;
  color: var(--text-secondary);
`

const modelCount = css`
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  padding: 2px 8px;
  border-radius: 10px;
`

const actions = css`
  display: flex;
  gap: 8px;
  justify-content: flex-end;
`

const detailPanel = css`
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px;
`

const modelItem = css`
  padding: 6px 10px;
  margin-bottom: 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
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
  border: 1px solid var(--border);
  color: var(--text-secondary);
`

const modelTagActive = css`
  border-color: var(--primary);
  color: var(--primary);
`

const sourceLink = css`
  font-size: 11px;
  color: var(--primary);
  text-decoration: none;
  &:hover {
    text-decoration: underline;
  }
`

/** 根据 models.dev 的 npm 字段推断 protocol。 */
function npmToProtocol(npm?: string): ProviderProtocol {
  if (!npm) return 'openai-compat'
  if (npm.includes('anthropic')) return 'anthropic'
  if (npm.includes('google')) return 'google'
  if (npm === '@ai-sdk/openai') return 'openai'
  return 'openai-compat'
}

/** 把选中的 catalog provider 转成 ProviderConfig。 */
function toProviderConfig(p: CatalogProvider): ProviderConfig {
  return {
    name: p.name,
    protocol: npmToProtocol(p.npm),
    baseURL: p.api ?? '',
    apiKey: '',
  }
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

  const { data: providersData, isLoading: providersLoading } = useQuery({
    queryKey: ['catalog', 'providers'],
    queryFn: () => catalogAPI.listProviders(),
  })

  const { data: modelsData, isLoading: modelsLoading } = useQuery({
    queryKey: ['catalog', 'providers', selectedId, 'models'],
    queryFn: () => catalogAPI.getProviderModels(selectedId ?? ''),
    enabled: !!selectedId,
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

  const selectedProvider = filtered.find((p) => p.id === selectedId) ?? null

  const handleSelect = () => {
    if (!selectedProvider) return
    onSelect(toProviderConfig(selectedProvider))
    onClose()
  }

  return (
    <div className={overlay} role="presentation" data-testid="provider-catalog-dialog">
      <div className={dialog}>
        <div className={title}>从 models.dev 目录选择 Provider</div>
        <input
          className={searchBar}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索 Provider 名称…"
          data-testid="catalog-search"
        />
        <div style={{ display: 'flex', gap: '8px', flex: 1, minHeight: 0 }}>
          <div className={listContainer} style={{ flex: '0 0 240px' }}>
            {providersLoading ? (
              <div style={{ padding: '12px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                加载中…
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
          <div className={detailPanel} style={{ flex: 1 }}>
            {!selectedId ? (
              <div style={{ padding: '12px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                从左侧选择 Provider 查看可用模型
              </div>
            ) : modelsLoading ? (
              <div style={{ padding: '12px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                加载模型列表…
              </div>
            ) : (
              <>
                <div style={{ marginBottom: '8px' }}>
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
        <div className={actions}>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            onClick={handleSelect}
            disabled={!selectedProvider}
            data-testid="catalog-confirm"
          >
            选择此 Provider
          </button>
        </div>
      </div>
    </div>
  )
}

export type { ProviderCatalogDialogProps }
