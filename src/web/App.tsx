import { css } from '@linaria/core'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { BrowserRouter, Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { TopBar } from './components/TopBar.js'
import { ConfigProvider } from './contexts/ConfigContext.js'
import { ThemeProvider } from './contexts/ThemeContext.js'
import { projectAPI } from './services/project.js'
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
          <BrowserRouter>
            <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
              <Routes>
                <Route path="/" element={<RootRedirect />} />
                <Route path="/projects/:projectId" element={<ChatPage />} />
                <Route path="/projects/:projectId/sessions/:sessionId" element={<ChatPage />} />
                <Route
                  path="/settings"
                  element={<Layout header={<TopBar />} main={<Settings />} />}
                />
                <Route path="*" element={<Layout header={<TopBar />} main={<NotFound />} />} />
              </Routes>
            </div>
          </BrowserRouter>
        </ConfigProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

const redirectMsg = css`
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  font-size: 14px;
  padding: 24px;
`

const errorState = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex: 1;
  color: var(--text-secondary);
  font-size: 14px;
  padding: 24px;
  text-align: center;
`

/**
 * 根路径重定向：解析当前工作区对应项目，跳转到项目路由。
 * history 模式下根路径无项目上下文，必须落到具体项目才能展示会话。
 * 加载中显示提示；失败显示错误引导而非静默循环。
 */
function RootRedirect() {
  const {
    data: project,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['project', 'current'],
    queryFn: projectAPI.current,
  })

  if (isLoading) {
    return (
      <Layout header={<TopBar />} main={<div className={redirectMsg}>正在解析当前项目…</div>} />
    )
  }
  if (isError || !project) {
    return (
      <Layout
        header={<TopBar />}
        main={
          <div className={errorState}>
            <span style={{ fontSize: 32 }}>⚠️</span>
            <span>无法解析当前项目，请前往设置确认工作区配置。</span>
            <Link
              to="/settings"
              style={{
                color: 'var(--primary)',
                textDecoration: 'none',
                padding: '8px 16px',
                border: '1px solid var(--primary)',
                borderRadius: 6,
              }}
            >
              前往设置
            </Link>
          </div>
        }
      />
    )
  }
  return <Navigate to={`/projects/${project.id}`} replace />
}

/**
 * 项目会话页：项目 id 来自路由（顶级维度），会话 id 可选。
 * 选会话 / 新建会话均导航到项目作用域路径，保证 URL 完整表达上下文。
 */
function ChatPage() {
  const { projectId, sessionId } = useParams<{ projectId: string; sessionId: string }>()
  const navigate = useNavigate()
  if (!projectId) return <Layout header={<TopBar />} main={<NotFound />} />
  return (
    <Layout
      header={<TopBar />}
      sidebar={
        <SessionList
          projectId={projectId}
          activeId={sessionId ?? null}
          onSelect={(id) => navigate(`/projects/${projectId}/sessions/${id}`)}
          onProjectChange={(id) => navigate(`/projects/${id}`)}
        />
      }
      main={<ChatView projectId={projectId} sessionId={sessionId ?? null} />}
    />
  )
}
