import type { ToolListItem } from '../types/index.js'
import { apiRequest } from './api.js'

const toolAPI = {
  /** 列出可用工具（不含 execute 函数）。 */
  list: () => apiRequest<ToolListItem[]>('/api/tools'),
}

export { toolAPI }
