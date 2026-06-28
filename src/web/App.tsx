import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HashRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { TopBar } from './components/TopBar.js'
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
            <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
              <Routes>
                <Route path="/" element={<ChatPage />} />
                <Route path="/sessions/:sessionId" element={<ChatPage />} />
                <Route
                  path="/settings"
                  element={<Layout header={<TopBar />} main={<Settings />} />}
                />
                <Route path="*" element={<Layout header={<TopBar />} main={<NotFound />} />} />
              </Routes>
            </div>
          </HashRouter>
        </ConfigProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

function ChatPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  return (
    <Layout
      header={<TopBar />}
      sidebar={
        <SessionList
          activeId={sessionId ?? null}
          onSelect={(id) => navigate(`/sessions/${id}`)}
        />
      }
      main={<ChatView sessionId={sessionId ?? null} />}
    />
  )
}
