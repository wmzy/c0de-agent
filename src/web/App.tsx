import { css } from '@linaria/core'
import { HistoryRouter, View } from '@native-router/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Button, LocaleProvider, zhCN } from 'haze-ui'
import { useEffect, useState } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary.js'
import { PairingApproval, PairingRequestFlow } from '@/components/PairingView.js'
import { TopBar } from '@/components/TopBar.js'
import { UpdateBanner } from '@/components/UpdateBanner.js'
import { ConfigProvider } from '@/contexts/ConfigContext.js'
import { ThemeProvider } from '@/contexts/ThemeContext.js'
import { routes } from '@/routes.js'
import { Layout } from '@/views/Layout.js'
import { NotFound } from '@/views/NotFound.js'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 2,
      refetchOnWindowFocus: true,
    },
  },
})

// 路由 baseUrl 与 vite base 同一事实源（painless 同款）：绝对 base 剥尾斜杠作
// 前缀；相对 base（dev/可移植部署）→ 空串原样匹配。不接时子路径部署的 SPA
// 全路径失配 → notFound。
const routerBaseUrl = import.meta.env.BASE_URL.startsWith('/')
  ? import.meta.env.BASE_URL.slice(0, -1)
  : ''

export function App() {
  // P2-16：API 401 → 显示新设备配对流程；已授权设备轮询待审批配对。
  const [authRequired, setAuthRequired] = useState(false)
  useEffect(() => {
    const onAuthRequired = () => setAuthRequired(true)
    window.addEventListener('c0de-auth-required', onAuthRequired)
    return () => window.removeEventListener('c0de-auth-required', onAuthRequired)
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ConfigProvider>
          <LocaleProvider strings={zhCN}>
            <HistoryRouter
              routes={routes}
              baseUrl={routerBaseUrl}
              notFound={<Layout header={<TopBar />} main={<NotFound />} />}
            >
              <ErrorBoundary>
                <div className={appShell}>
                  <UpdateBanner />
                  <FirstDeviceNotice />
                  {authRequired && <PairingRequestFlow />}
                  <PairingApproval onDone={() => {}} />
                  <View />
                </div>
              </ErrorBoundary>
            </HistoryRouter>
          </LocaleProvider>
        </ConfigProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

const appShell = css`
  display: flex;
  flex-direction: column;
  height: 100dvh;
`

/* P1-3：首设备注册一次性确认条（sessionStorage 标记，注册后刷新展示一次）。 */
const FIRST_DEVICE_KEY = 'c0de-auth-registered'

const deviceNotice = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  background: var(--haze-color-bg-subtle);
  border-bottom: 1px solid var(--haze-color-border);
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  flex-shrink: 0;

  & > button {
    border: 1px solid var(--haze-color-border);
    border-radius: 4px;
    background: var(--haze-color-bg);
    color: var(--haze-color-text);
    cursor: pointer;
    font-size: 12px;
    padding: 2px 8px;
  }
`

/** 展示首设备注册结果：用户可核对注册的确实是本浏览器（先到先得竞态的可见性补偿）。 */
function FirstDeviceNotice() {
  const [name, setName] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(FIRST_DEVICE_KEY)
    } catch {
      return null
    }
  })
  if (!name) return null
  const dismiss = () => {
    setName(null)
    try {
      sessionStorage.removeItem(FIRST_DEVICE_KEY)
    } catch {
      // ignore
    }
  }
  return (
    <div className={deviceNotice} data-testid="first-device-notice">
      <span>本浏览器已注册为本机设备「{name}」。可在 设置 → 安全 → 已授权设备 查看与管理。</span>
      <Button onClick={dismiss} variant="outline">
        知道了
      </Button>
    </div>
  )
}
