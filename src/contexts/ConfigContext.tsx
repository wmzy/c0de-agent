import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

type ProviderConfig = {
  apiKey: string
  baseUrl: string
  model: string
}

type ConfigState = {
  config: ProviderConfig | null
  isConfigured: boolean
  isLoading: boolean
}

type ConfigContextValue = ConfigState & {
  saveConfig: (config: ProviderConfig) => Promise<void>
  logout: () => void
}

const ConfigContext = createContext<ConfigContextValue | null>(null)

async function fetchConfig(): Promise<{ configured: boolean; model?: string }> {
  const response = await fetch('/api/config')
  if (!response.ok) throw new Error('Failed to fetch config')
  return response.json()
}

async function saveConfigToServer(config: ProviderConfig): Promise<void> {
  const response = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!response.ok) throw new Error('Failed to save config')
}

export function ConfigProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [localConfig, setLocalConfig] = useState<ProviderConfig | null>(() => {
    const saved = localStorage.getItem('c0de-config')
    return saved ? JSON.parse(saved) : null
  })

  const { data: serverConfig, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: fetchConfig,
    retry: false,
  })

  const saveMutation = useMutation({
    mutationFn: saveConfigToServer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config'] })
    },
  })

  const saveConfig = async (config: ProviderConfig) => {
    localStorage.setItem('c0de-config', JSON.stringify(config))
    setLocalConfig(config)
    await saveMutation.mutateAsync(config)
  }

  const logout = () => {
    localStorage.removeItem('c0de-config')
    setLocalConfig(null)
    queryClient.setQueryData(['config'], { configured: false })
  }

  const isConfigured = serverConfig?.configured ?? false

  return (
    <ConfigContext.Provider
      value={{
        config: localConfig,
        isConfigured,
        isLoading: isLoading && !localConfig,
        saveConfig,
        logout,
      }}
    >
      {children}
    </ConfigContext.Provider>
  )
}

export function useConfigContext() {
  const context = useContext(ConfigContext)
  if (!context) {
    throw new Error('useConfigContext must be used within ConfigProvider')
  }
  return context
}
