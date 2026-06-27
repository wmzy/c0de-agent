import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HashRouter, Route, Routes } from 'react-router-dom'
import { ConfigProvider } from './contexts/ConfigContext.js'
import { ThemeProvider } from './contexts/ThemeContext.js'
import { ChatView } from './views/ChatView.js'
import { Layout } from './views/Layout.js'
import { NotFound } from './views/NotFound.js'
import { SessionList } from './views/SessionList.js'
import { Settings } from './views/Settings.js'

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

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ConfigProvider>
          <HashRouter>
            <Routes>
              <Route
                path="/"
                element={
                  <Layout
                    sidebar={<SessionList activeId={null} onSelect={() => {}} />}
                    main={<ChatView />}
                  />
                }
              />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </HashRouter>
        </ConfigProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
