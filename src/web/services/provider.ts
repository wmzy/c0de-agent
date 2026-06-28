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

const providerAPI = {
  /** 列出已配置 providers（apiKey 脱敏）。 */
  list: () => apiRequest<ProviderListResponse>('/api/providers'),
  /** 用给定凭据探测 OpenAI 兼容 /models 端点。 */
  test: (baseURL: string, apiKey: string) =>
    apiRequest<TestResult>('/api/providers/test', {
      method: 'POST',
      body: JSON.stringify({ baseURL, apiKey }),
    }),
}

export type { ProviderListItem, ProviderListResponse, TestResult }
export { providerAPI }
