import { apiRequest } from './api.js'

/** 已配置 provider 列表项（apiKey 脱敏）。 */
type ProviderListItem = {
  name: string
  protocol: 'openai' | 'anthropic' | 'google' | 'openai-compat'
  baseURL: string
  hasKey: boolean
}

type ProviderListResponse = {
  providers: ProviderListItem[]
  defaultProvider: string
}

/** 连接测试结果。 */
type TestResult = { ok: true; models: string[] } | { ok: false; error: string }

/** 模型能力（GET /api/providers/capabilities 返回）。 */
type ModelCapabilitiesInfo = {
  provider: string
  model: string
  supportsVision: boolean
  supportsThinking: boolean
  contextWindow: number
}

const providerAPI = {
  /** 列出已配置 providers（apiKey 脱敏）。 */
  list: () => apiRequest<ProviderListResponse>('/api/providers'),
  /** 查询模型能力（多模态入口按能力显隐）。 */
  capabilities: (provider: string, model: string) =>
    apiRequest<ModelCapabilitiesInfo>(
      `/api/providers/capabilities?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`,
    ),
  /** 用给定凭据探测 OpenAI 兼容 /models 端点。 */
  test: (baseURL: string, apiKey: string) =>
    apiRequest<TestResult>('/api/providers/test', {
      method: 'POST',
      body: JSON.stringify({ baseURL, apiKey }),
    }),
}

export type { ModelCapabilitiesInfo, ProviderListItem, ProviderListResponse, TestResult }
export { providerAPI }
