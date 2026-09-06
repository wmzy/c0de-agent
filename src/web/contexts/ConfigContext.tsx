import type { Config } from '@shared/types/config.js'
import { useQuery } from '@tanstack/react-query'
import { createContext, useCallback, useContext } from 'react'
import { configAPI } from '../services/config.js'

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

/**
 * 全局配置上下文（服务启动目录的合并配置）。
 *
 * 与配置页共享同一个 react-query 缓存（queryKey ['config', 'server']）：
 * 配置页保存后 `invalidateQueries(['config'])` 会同时刷新本上下文，
 * 使会话页 ModelSelector 等消费方立即拿到最新 config（含 provider models）。
 */
export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const {
    data: resp,
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ['config', 'server'],
    queryFn: () => configAPI.get(),
  })

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
 * 独立 query 缓存键，与服务器级配置互不污染）；缺省读服务启动目录配置。
 */
export function useConfig(projectId?: string): ConfigContextValue {
  const serverCtx = useContext(ConfigContext)
  if (!serverCtx) throw new Error('useConfig must be used within ConfigProvider')

  const projectQuery = useQuery({
    queryKey: ['config', 'project', projectId],
    queryFn: () => configAPI.get(projectId),
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
