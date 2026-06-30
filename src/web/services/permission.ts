import { apiRequest } from './api.js'

/** 全局授权模式：'default' 逐个确认，'auto' 自动放行 ask 工具（YOLO）。 */
type PermissionMode = 'default' | 'auto'

const permissionAPI = {
  getMode: () => apiRequest<{ mode: PermissionMode }>('/api/permissions'),
  setMode: (mode: PermissionMode) =>
    apiRequest<{ mode: PermissionMode }>('/api/permissions', {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    }),
}

export type { PermissionMode }
export { permissionAPI }
