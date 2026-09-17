import { useMatched, useRouter } from '@native-router/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { type SidebarTab, SidebarTabs } from '@/components/SidebarTabs.js'
import { TerminalPanel } from '@/components/TerminalPanel.js'
import { TopBar } from '@/components/TopBar.js'
import {
  type FileSelection,
  FileSelectionContext,
  type LineRange,
} from '@/contexts/FileSelectionContext.js'
import { FileReferenceProvider } from '@/contexts/ReferenceContext.js'
import { useTerminal } from '@/hooks/useTerminal.js'
import { navigateTo } from '@/navigateTo.js'
import { projectAPI } from '@/services/project.js'
import { ChatView } from '@/views/ChatView.js'
import { FileBrowser } from '@/views/FileBrowser.js'
import { FilePreview } from '@/views/FilePreview.js'
import { Layout } from '@/views/Layout.js'
import { NotFound } from '@/views/NotFound.js'
import { SessionList } from '@/views/SessionList.js'

/**
 * 项目会话页：项目 id 来自路由（顶级维度），会话 id 可选。
 * 选会话 / 新建会话均导航到项目作用域路径，保证 URL 完整表达上下文。
 */
export function ChatPage() {
  const { params } = useMatched()
  const projectId = params.projectId
  const sessionId = params.sessionId
  const router = useRouter()
  // projectId 来自路由 :projectId 段，缺失时下方 `if (!projectId)` 会渲染 NotFound；
  // Hook 必须无条件调用，故用 `?? ''` 提供稳定 string，query 由 enabled 守卫。
  const terminal = useTerminal(projectId ?? '')

  // 获取项目信息（worktree 用于终端默认目录）
  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => {
      // enabled: !!projectId 保证仅当 projectId 为真值时执行
      if (!projectId) throw new Error('projectId is required')
      return projectAPI.get(projectId)
    },
    enabled: !!projectId,
  })

  // Ctrl+` 切换终端面板显示/隐藏
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault()
        terminal.toggleOpen()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [terminal])
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
                  onSelect={(id) =>
                    navigateTo(router, '/projects/:projectId/sessions/:sessionId', {
                      params: { projectId, sessionId: id },
                    })
                  }
                  onNewSession={() =>
                    navigateTo(router, '/projects/:projectId', { params: { projectId } })
                  }
                  onDeleted={(id) => {
                    // 删除的是当前会话则跳回草稿新会话页
                    if (id === (sessionId ?? null)) {
                      navigateTo(router, '/projects/:projectId', { params: { projectId } })
                    }
                  }}
                />
              }
              files={
                <FileBrowser
                  projectId={projectId}
                  onPick={(p) => fileCtx.openFile(p)}
                  onDelete={(p) => {
                    // 被删文件/目录是当前预览目标（含子路径）时关闭预览
                    if (selectedFile === p || selectedFile?.startsWith(`${p}/`)) {
                      fileCtx.closeFile()
                    }
                  }}
                />
              }
            />
          }
          main={<ChatView projectId={projectId} sessionId={sessionId ?? null} />}
          panel={selectedFile ? <FilePreview projectId={projectId} path={selectedFile} /> : null}
          terminal={<TerminalPanel terminal={terminal} cwd={project?.worktree} />}
        />
      </FileSelectionContext.Provider>
    </FileReferenceProvider>
  )
}
