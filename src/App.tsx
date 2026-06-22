import { Suspense, useEffect, type ComponentType, type LazyExoticComponent } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { cx } from '@linaria/core'
import { ToastContainer, useToast, Spinner, Button } from 'haze-ui'
import { setToastHandler } from './utils/toast'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AppQueryProvider } from './hooks/useQueryClient'
import { ConfigProvider, useConfigContext } from './contexts/ConfigContext'
import { useConfig } from './hooks/useConfig'
import { globalStyles } from './styles/global'
import { ROUTE_PAGES, ROUTE_NAV_ITEMS } from './router'

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

function ToastInitializer() {
  const toastFn = useToast()
  useEffect(() => {
    setToastHandler(toastFn)
  }, [toastFn])
  return null
}

function PageFallback() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
      <Spinner />
    </div>
  )
}

type RouteDef = {
  path: string
  Component: LazyExoticComponent<ComponentType<unknown>>
}

const ROUTES: RouteDef[] = Object.entries(ROUTE_PAGES).map(([path, entry]) => ({
  path,
  Component: entry.Component,
}))

export function App() {
  return (
    <ErrorBoundary>
      <AppQueryProvider>
        <BrowserRouter>
          <ConfigProvider>
            <ToastInitializer />
            <Routes>
              <Route element={<ProtectedRoute />}>
                <Route element={<AppLayout />}>
                  {ROUTES.map(({ path, Component }) => (
                    <Route
                      key={path}
                      path={path}
                      element={
                        <Suspense fallback={<PageFallback />}>
                          <Component />
                        </Suspense>
                      }
                    />
                  ))}
                  <Route path="/" element={<Navigate to="/chat" replace />} />
                </Route>
              </Route>
              <Route path="/settings" element={
                <Suspense fallback={<PageFallback />}>
                  {(() => {
                    const Comp = ROUTE_PAGES['/settings'].Component
                    return <Comp />
                  })()}
                </Suspense>
              } />
            </Routes>
          </ConfigProvider>
        </BrowserRouter>
      </AppQueryProvider>
    </ErrorBoundary>
  )
}
