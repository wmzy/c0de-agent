import type { Config } from '@shared/types/config.js'
import { apiRequest } from './api.js'

/** GET/PATCH /api/config 响应（P1-7：含作用域信息与 apiKey 解密警告）。 */
type ConfigResponse = {
  config: Config
  scopes: {
    global: Partial<Config> | null
    project: Partial<Config> | null
  }
  warnings: string[]
  /** 安全类配置（token/authEnabled）运行时修改不生效，需重启 serve（PATCH 响应）。 */
  needsRestart?: boolean
}

const configAPI = {
  get: () => apiRequest<ConfigResponse>('/api/config'),
  update: (patch: Partial<Config>, scope?: 'global' | 'project') =>
    apiRequest<ConfigResponse>('/api/config', {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, ...(scope ? { scope } : {}) }),
    }),
}

export type { ConfigResponse }
export { configAPI }
