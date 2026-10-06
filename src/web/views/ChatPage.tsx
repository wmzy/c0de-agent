import { useMatched, useRouter } from '@native-router/react'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type SidebarTab, SidebarTabs } from '@/components/SidebarTabs.js'
import { TerminalPanel } from '@/components/TerminalPanel.js'
import { TopBar } from '@/components/TopBar.js'
import {
  type FileChangeGuard,
  type FileSelection,
  FileSelectionContext,
  type LineRange,
} from '@/contexts/FileSelectionContext.js'
import { FileReferenceProvider } from '@/contexts/ReferenceContext.js'
import { useTerminal } from '@/hooks/useTerminal.js'
import { navigateTo } from '@/navigateTo.js'
import { projectAPI } from '@/services/project.js'
import { storageGet, storageSet } from '@/utils/storage.js'
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
  // 预览面板注册的「变更前否决」钩子（见 FileSelectionContext.registerGuard）。
  // 用 ref 而非 state：openFile/closeFile 是同步决策，不能在等一次重渲染后才拿到它。
  const guardRef = useRef<FileChangeGuard | null>(null)
  // 稳定身份：FilePreview 按 [registerGuard] 注册/注销，内联函数会让它每次渲染都重注册
  const registerGuard = useCallback((fn: FileChangeGuard | null) => {
    guardRef.current = fn
  }, [])
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(
    () => (storageGet('c0de-agent:sidebarTab') as SidebarTab) ?? 'sessions',
  )
  const switchTab = (t: SidebarTab) => {
    setSidebarTab(t)
    storageSet('c0de-agent:sidebarTab', t)
  }

  const fileCtx: FileSelection = {
    selectedFile,
    openFile: (path: string, range?: LineRange) => {
      // 先问预览面板的否决钩子：它有未保存的编辑时会拦下本次切换并弹确认，
      // 否则旧编辑器随 query 换 key 卸载，缓冲区里的修改就被静默丢弃。
      if (guardRef.current?.({ path, range }) === false) return
      setSelectedFile(path)
      setRevealRange(range ?? null)
    },
    closeFile: () => {
      if (guardRef.current?.(null) === false) return
      setSelectedFile(null)
      setRevealRange(null)
    },
    revealRange,
    registerGuard,
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
          main={
            <ChatView
              projectId={projectId}
              sessionId={sessionId ?? null}
              terminalToggle={{ open: terminal.open, onToggle: terminal.toggleOpen }}
            />
          }
          panel={selectedFile ? <FilePreview projectId={projectId} path={selectedFile} /> : null}
          terminal={<TerminalPanel terminal={terminal} cwd={project?.worktree} />}
        />
      </FileSelectionContext.Provider>
    </FileReferenceProvider>
  )
}
