import { Suspense, type ComponentType, type LazyExoticComponent } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { cx } from '@linaria/core'
import { ToastContainer, Spinner, Button, lightTheme } from 'haze-ui'
import { AppQueryProvider } from './hooks/useQueryClient'
import { ConfigProvider, useConfigContext } from './contexts/ConfigContext'
import { useConfig } from './hooks/useConfig'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ROUTE_PAGES, ROUTE_NAV_ITEMS } from './router'
import { globalStyles } from './styles/global'

// Lazy load pages
const SettingsPage = async () => import('./pages/SettingsPage')
const ChatPage = async () => import('./pages/ChatPage')

function ProtectedRoute() {
  const { isConfigured, isLoading } = useConfig()
  if (isLoading) return null
  if (!isConfigured) return <Navigate to="/settings" replace />
  return <Outlet />
}

function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { config, logout } = useConfig()

  return (
    <div>
      <header
        style={{
          height: 64,
          borderBottom: '1px solid var(--haze-color-border)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 24px',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <span style={{ fontWeight: 700, fontSize: 18 }}>c0de-agent</span>
          <nav style={{ display: 'flex', gap: 8 }}>
            {ROUTE_NAV_ITEMS.map((item) => (
              <Button
                key={item.path}
                variant={location.pathname === item.path ? 'solid' : 'ghost'}
                size="sm"
                onClick={() => navigate(item.path)}
              >
                {item.label}
              </Button>
            ))}
          </nav>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {config && (
            <span style={{ fontSize: 12, color: 'var(--haze-color-text-muted)' }}>
              {config.model}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={logout}>
            退出
          </Button>
        </div>
      </header>
      <Outlet />
    </div>
  )
}

function PageFallback() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
      <Spinner />
    </div>
  )
}

// Simple lazy wrapper
function LazyPage({ loader }: { loader: () => Promise<{ default: ComponentType<unknown> }> }) {
  const [Comp, setComp] = useState<ComponentType<unknown> | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useState(() => {
    loader()
      .then((m) => setComp(() => m.default))
      .catch(setError)
  })

  if (error) throw error
  if (!Comp) return <PageFallback />
  return <Comp />
}

import { useState, useEffect } from 'react'

export function App() {
  return (
    <div className={cx(globalStyles, lightTheme)}>
      <ErrorBoundary>
        <AppQueryProvider>
          <ConfigProvider>
            <BrowserRouter>
              <ToastContainer>
                <Suspense fallback={<PageFallback />}>
                  <Routes>
                    <Route element={<ProtectedRoute />}>
                      <Route element={<AppLayout />}>
                        <Route
                          path="/chat"
                          element={<LazyPage loader={() => import('./pages/ChatPage')} />}
                        />
                        <Route path="/" element={<Navigate to="/chat" replace />} />
                      </Route>
                    </Route>
                    <Route
                      path="/settings"
                      element={<LazyPage loader={() => import('./pages/SettingsPage')} />}
                    />
                  </Routes>
                </Suspense>
              </ToastContainer>
            </BrowserRouter>
          </ConfigProvider>
        </AppQueryProvider>
      </ErrorBoundary>
    </div>
  )
}
