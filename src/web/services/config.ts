import type { Config } from '@shared/types/config.js'
import { apiRequest } from './api.js'

const configAPI = {
  get: () => apiRequest<Config>('/api/config'),
  update: (patch: Partial<Config>) =>
    apiRequest<Config>('/api/config', { method: 'PATCH', body: JSON.stringify(patch) }),
}

export { configAPI }
