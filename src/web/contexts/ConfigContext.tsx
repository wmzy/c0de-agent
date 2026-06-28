import type { Config } from '@shared/types/config.js'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createContext, useCallback, useContext } from 'react'
import { configAPI } from '../services/config.js'

type ConfigContextValue = {
  config: Config | null
  loading: boolean
  refresh: () => Promise<void>
}

const ConfigContext = createContext<ConfigContextValue | null>(null)

/**
 * 全局配置上下文。
 *
 * 与配置页共享同一个 react-query 缓存（queryKey ['config']）：
 * 配置页保存后 `invalidateQueries(['config'])` 会同时刷新本上下文，
 * 使会话页 ModelSelector 等消费方立即拿到最新 config（含 provider models）。
 */
export function ConfigProvider({ children }: { children: ReactNode }) {
  const {
    data: config,
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ['config'],
    queryFn: () => configAPI.get(),
  })

  const refresh = useCallback(async () => {
    await refetch()
  }, [refetch])

  return (
    <ConfigContext.Provider value={{ config: config ?? null, loading, refresh }}>
      {children}
    </ConfigContext.Provider>
  )
}

export function useConfig(): ConfigContextValue {
  const ctx = useContext(ConfigContext)
  if (!ctx) throw new Error('useConfig must be used within ConfigProvider')
  return ctx
}
