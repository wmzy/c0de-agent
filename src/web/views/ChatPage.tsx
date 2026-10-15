import { useMatched, useRouter } from '@native-router/react'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type SidebarTab, SidebarTabs } from '@/components/SidebarTabs.js'
import { TerminalPanel } from '@/components/TerminalPanel.js'
import { TopBar } from '@/components/TopBar.js'
import {
  type DirtyProbe,
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

/** 失败原因取服务端 message（APIError）或 Error.message，与本仓其余提示同口径。 */
function messageOf(e: unknown): string {
  return (e as { message?: string } | null)?.message ?? (e instanceof Error ? e.message : String(e))
}

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
  //
  // 读取失败此前只表现为 project=undefined，与「还在加载」同形，页面上没有任何
  // 区别：终端面板拿不到 cwd，于是不自动建首个终端、空态里的「新建终端」按钮随之
  // 消失（按 cwd 门控），用户落在一个没有出口的空面板上，既不知道「项目目录没读到」
  // 也没有重试入口。失败必须说出来，并把重试交到面板里。
  const {
    data: project,
    isError: projectFailed,
    error: projectError,
    refetch: refetchProject,
  } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => {
      // enabled: !!projectId 保证仅当 projectId 为真值时执行
      if (!projectId) throw new Error('projectId is required')
      return projectAPI.get(projectId)
    },
    enabled: !!projectId,
  })
  const cwdLoadError = useMemo(
    () =>
      projectFailed
        ? { message: messageOf(projectError), retry: () => void refetchProject() }
        : null,
    [projectFailed, projectError, refetchProject],
  )

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
  // 预览面板注册的「当前是否有未保存修改」探针：给「会离开本页」的动作在动手之前
  // 一个判据（草稿页发送首条消息要先跳会话页，而那次导航在脏时必被 veto）。
  const dirtyProbeRef = useRef<DirtyProbe | null>(null)
  const registerDirtyProbe = useCallback((fn: DirtyProbe | null) => {
    dirtyProbeRef.current = fn
  }, [])
  const hasUnsavedEdits = useCallback(() => dirtyProbeRef.current?.() === true, [])
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
    registerDirtyProbe,
    hasUnsavedEdits,
  }

  /**
   * 切项目时收起预览面板：selectedFile 是**相对路径**，而预览按最新的 projectId
   * 重新读取，于是「我正在看 A 的 src/app.ts」会被静默换成 B 的同名文件
   * （实测 /projects/A 打开 src/app.ts 后从顶栏切到 B：路径不变、内容变成 B 的）。
   * 项目作用域的本地 state 必须自己重置——同 path 换 param 不会重挂载本组件
   * （SessionList 的 firstProjectRef 是同一口径）。
   *
   * 直接清空、不再经 closeFile 的否决钩子：未保存编辑的去留已经在导航那一刻由
   * FilePreview 的 useBlocker 问过一遍（用户按「离开」才走得到这里），再问一次
   * 就是连续两次同样的确认。
   */
  const firstProjectRef = useRef(projectId)
  useEffect(() => {
    if (firstProjectRef.current === projectId) return
    firstProjectRef.current = projectId
    setSelectedFile(null)
    setRevealRange(null)
  }, [projectId])

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
          terminal={
            <TerminalPanel
              terminal={terminal}
              cwd={project?.worktree}
              projectId={projectId}
              cwdLoadError={cwdLoadError}
            />
          }
        />
      </FileSelectionContext.Provider>
    </FileReferenceProvider>
  )
}
