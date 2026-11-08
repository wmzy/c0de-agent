import type { Config } from '@shared/types/config.js'
import { useQuery } from '@tanstack/react-query'
import { createContext, useCallback, useContext } from 'react'
import { configAPI } from '@/services/config.js'

type ConfigContextValue = {
  config: Config | null
  loading: boolean
  /** apiKey 解密失败等配置警告（P1-7）。 */
  warnings: string[]
  /** 作用域信息：global/project 原始配置（设置页作用域标注用）。 */
  scopes: { global: Partial<Config> | null; project: Partial<Config> | null }
  refresh: () => Promise<void>
}

const ConfigContext = createContext<ConfigContextValue | null>(null)

/** config 查询的共享 queryOptions：ConfigProvider / useConfig / TopBar 徽标 /
 *  Settings 配置页四方共用同一缓存键，同一份 configAPI.get(projectId) 数据在
 *  缓存里只存一份——此前 TopBar/Settings 用 ['config', projectId ?? 'server']
 *  而 useConfig 用 ['config', 'project', id]，同一请求存两份缓存。键均以
 *  'config' 开头，保存后 invalidateQueries({ queryKey: ['config'] }) 的前缀
 *  失效全部命中；projectId 缺省（server 口径，哈希为 null）与任何具体项目 id
 *  不同键，互不污染。
 *
 *  staleTime 故意不内建：共享键下新鲜度由**已挂载的最严观察者**裁决——设置页
 *  编辑器（staleTime 0，refetchOnWindowFocus 兜住外部并发改动）挂载时聚焦/挂载
 *  即重取共享缓存；仅顶栏徽标在场的页面沿用其 60s 节流。 */
export function configQueryOptions(projectId?: string) {
  return {
    queryKey: ['config', 'project', projectId] as const,
    queryFn: () => configAPI.get(projectId),
  }
}

/**
 * 全局配置上下文（服务启动目录的合并配置）。
 *
 * 与配置页 / 顶栏徽标共享同一个 react-query 缓存（configQueryOptions 的键）：
 * 配置页保存后 `invalidateQueries(['config'])` 会同时刷新本上下文，
 * 使会话页 ModelSelector 等消费方立即拿到最新 config（含 provider models）。
 */
export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const { data: resp, isLoading: loading, refetch } = useQuery(configQueryOptions())

  const refresh = useCallback(async () => {
    await refetch()
  }, [refetch])

  return (
    <ConfigContext.Provider
      value={{
        config: resp?.config ?? null,
        loading,
        warnings: resp?.warnings ?? [],
        scopes: resp?.scopes ?? { global: null, project: null },
        refresh,
      }}
    >
      {children}
    </ConfigContext.Provider>
  )
}

/**
 * 读取配置。projectId 提供时读取该项目的合并配置（P1-1 多项目配置贯通，
 * 独立 query 缓存键——configQueryOptions：项目 id 各占一键，与服务器级配置
 * 互不污染）；缺省读服务启动目录配置。
 */
export function useConfig(projectId?: string): ConfigContextValue {
  const serverCtx = useContext(ConfigContext)
  if (!serverCtx) throw new Error('useConfig must be used within ConfigProvider')

  const projectQuery = useQuery({
    ...configQueryOptions(projectId),
    enabled: !!projectId,
  })
  const refresh = useCallback(async () => {
    await projectQuery.refetch()
  }, [projectQuery.refetch])

  if (!projectId) return serverCtx

  const resp = projectQuery.data
  return {
    config: resp?.config ?? null,
    loading: projectQuery.isLoading,
    warnings: resp?.warnings ?? [],
    scopes: resp?.scopes ?? { global: null, project: null },
    refresh,
  }
}
