import { css } from '@linaria/core'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router-dom'
import { type SidebarTab, SidebarTabs } from './components/SidebarTabs.js'
import { TopBar } from './components/TopBar.js'
import { UpdateBanner } from './components/UpdateBanner.js'
import { ConfigProvider } from './contexts/ConfigContext.js'
import {
  type FileSelection,
  FileSelectionContext,
  type LineRange,
} from './contexts/FileSelectionContext.js'
import { FileReferenceProvider } from './contexts/ReferenceContext.js'
import { ThemeProvider } from './contexts/ThemeContext.js'
import { projectAPI } from './services/project.js'
import { ChatView } from './views/ChatView.js'
import { FileBrowser } from './views/FileBrowser.js'
import { FilePreview } from './views/FilePreview.js'
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
            <div className={appShell}>
              <UpdateBanner />
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

const appShell = css`
  display: flex;
  flex-direction: column;
  height: 100dvh;
`

const errorIcon = css`
  font-size: 32px;
`

const errorLink = css`
  color: var(--primary);
  text-decoration: none;
  padding: 8px 16px;
  border: 1px solid var(--primary);
  border-radius: 6px;
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
            <span className={errorIcon}>⚠️</span>
            <span>无法解析当前项目，请前往设置确认工作区配置。</span>
            <Link to="/settings" className={errorLink}>
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
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [revealRange, setRevealRange] = useState<LineRange | null>(null)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(
    () => (localStorage.getItem('c0de-agent:sidebarTab') as SidebarTab) ?? 'sessions',
  )
  const switchTab = (t: SidebarTab) => {
    setSidebarTab(t)
    localStorage.setItem('c0de-agent:sidebarTab', t)
  }

  const fileCtx: FileSelection = {
    selectedFile,
    openFile: (path: string, range?: LineRange) => {
      setSelectedFile(path)
      setRevealRange(range ?? null)
    },
    closeFile: () => {
      setSelectedFile(null)
      setRevealRange(null)
    },
    revealRange,
  }

  if (!projectId) return <Layout header={<TopBar />} main={<NotFound />} />

  return (
    <FileReferenceProvider>
      <FileSelectionContext.Provider value={fileCtx}>
        <Layout
          header={<TopBar />}
          sidebar={
            <SidebarTabs
              activeTab={sidebarTab}
              onSwitch={switchTab}
              sessions={
                <SessionList
                  projectId={projectId}
                  activeId={sessionId ?? null}
                  onSelect={(id) => navigate(`/projects/${projectId}/sessions/${id}`)}
                  onProjectChange={(id) => navigate(`/projects/${id}`)}
                  onNewSession={() => navigate(`/projects/${projectId}`)}
                  onDeleted={(id) => {
                    // 删除的是当前会话则跳回草稿新会话页
                    if (id === (sessionId ?? null)) navigate(`/projects/${projectId}`)
                  }}
                />
              }
              files={<FileBrowser projectId={projectId} onPick={(p) => fileCtx.openFile(p)} />}
            />
          }
          main={<ChatView projectId={projectId} sessionId={sessionId ?? null} />}
          panel={selectedFile ? <FilePreview projectId={projectId} path={selectedFile} /> : null}
        />
      </FileSelectionContext.Provider>
    </FileReferenceProvider>
  )
}
