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
  /** 项目级配置含密钥且位于 git 仓库内时提示 .gitignore（GET 响应）。 */
  gitWarning?: string | null
  /** 安全类配置（token/authEnabled）运行时修改不生效，需重启 serve（PATCH 响应）。 */
  needsRestart?: boolean
  /** P1-1：请求指定项目（projectId）时的项目目录（设置页标注编辑目标用）。 */
  projectDir?: string
}

const configAPI = {
  /** projectId 提供时读取该项目的合并配置（P1-1 多项目配置贯通）。 */
  get: (projectId?: string) =>
    apiRequest<ConfigResponse>(
      `/api/config${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  update: (patch: Partial<Config>, scope?: 'global' | 'project', projectId?: string) =>
    apiRequest<ConfigResponse>('/api/config', {
      method: 'PATCH',
      body: JSON.stringify({
        ...patch,
        ...(scope ? { scope } : {}),
        ...(projectId ? { projectId } : {}),
      }),
    }),
}

export type { ConfigResponse }
export { configAPI }
