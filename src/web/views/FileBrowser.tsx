import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog } from '@/components/Dialog.js'
import { FileTree, type TreeNode } from '@/components/FileTree.js'
import { SyncedInput } from '@/components/SyncedControls.js'
import { useFileReference } from '@/contexts/ReferenceContext.js'
import { useProjects } from '@/hooks/useSession.js'
import { fileAPI } from '@/services/file.js'
import { btnDanger, btnSm } from '@/styles/tokens.js'
import type { FileEntry, FileSearchResult, GitStatusMap } from '@/types/index.js'

const panel = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`

const headerBar = css`
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 8px 8px 0;
`

const searchInputFlex = css`
  flex: 1;
  min-width: 0;
  min-height: 36px;
  padding: 4px 8px;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  font-size: 13px;
  &:focus {
    outline: none;
    border-color: var(--haze-color-primary);
  }
`

const treeScroll = css`
  flex: 1;
  overflow: auto;
  padding: 4px 0;
`

const resultRow = css`
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  min-height: 36px;
  padding: 2px 8px;
  cursor: pointer;
  border: none;
  background: transparent;
  color: var(--haze-color-text);
  font-size: 12.5px;
  text-align: left;
  &:hover {
    background: var(--haze-color-bg-subtle);
  }
`

const searchMentionBtn = css`
  opacity: 0.65;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--haze-color-text-secondary);
  cursor: pointer;
  font-size: 11px;
  padding: 0;
  min-height: 32px;
  min-width: 32px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.1s, color 0.1s;
  &:hover {
    color: var(--haze-color-primary);
  }
`

const searchDeleteBtn = css`
  opacity: 0.65;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--haze-color-text-secondary);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
  min-height: 32px;
  min-width: 32px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.1s, color 0.1s;
  &:hover {
    color: var(--haze-color-danger);
  }
`

const empty = css`
  padding: 12px 8px;
  color: var(--haze-color-text-secondary);
  font-size: 12px;
`

const loading = css`
  padding: 12px 8px;
  color: var(--haze-color-text-secondary);
  font-size: 12px;
`

/**
 * 加载失败态：标题 + 原因 + 重试三段式（与 KanbanView / FilePreview 的读失败态同
 * 口径）。此前根目录列目录失败被 `.catch(() => {})` 吞掉，树恒为 null，面板永远
 * 停在「加载中…」；搜索失败则落进空态，把「查不到」说成「不存在」。
 */
const errorState = css`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 12px 8px;
`

const errorTitle = css`
  color: var(--haze-color-danger);
  font-size: 13px;
  font-weight: 600;
`

const errorDetail = css`
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  /* 后端 message 可能是长路径/长句子，窄栏下必须能断行而不是撑出横向滚动 */
  overflow-wrap: anywhere;
`

const retryBtn = css`
  padding: 4px 12px;
  font-size: 12px;
`

/** 删除确认弹层的说明正文。路径可能很长，必须能断行。 */
const confirmText = css`
  font-size: 13px;
  line-height: 1.6;
  color: var(--haze-color-text);
  overflow-wrap: anywhere;
`

/** 删除确认弹层里的失败原因框：标题 + 后端 message（与上方读失败态同口径）。 */
const confirmError = css`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
`

/** 搜索结果列表：原生 ul/li 语义（读屏从树切换到搜索时有明确上下文）。 */
const resultList = css`
  display: flex;
  flex-direction: column;
  list-style: none;
`

/** 搜索结果行容器。 */
const resultItem = css`
  display: flex;
  align-items: center;
  gap: 2px;
  &:hover [data-search-mention] {
    opacity: 1;
  }
  &:hover [data-search-delete] {
    opacity: 1;
  }
`

/** 「显示隐藏目录」开关：紧凑方形按钮，收在搜索框旁。 */
const hiddenToggle = css`
  flex-shrink: 0;
  min-height: 36px;
  min-width: 36px;
  padding: 0;
  font-size: 14px;
  line-height: 1;
  &[aria-pressed='true'] {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-primary);
  }
`

/**
 * 内置忽略清单：依赖/构建产物/覆盖率/缓存等噪音目录，
 * 默认从文件树过滤（与 git ignore 无关，纯 UI 降噪），可用开关找回。
 * type 缺省视为 directory，按名字精确匹配。
 */
const HIDDEN_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.worktrees',
  'node_modules',
  'bower_components',
  'dist',
  'dist-web',
  'dev-dist',
  'build',
  'out',
  'coverage',
  '.nyc_output',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.vite',
  '.yarn',
  '.next',
  '.nuxt',
  '.svelte-kit',
])

/** 递归过滤：从树中移除命中忽略清单的目录（不可变更新）。 */
function filterHiddenDirs(node: TreeNode): TreeNode {
  if (!node.children) return node
  return {
    ...node,
    children: node.children
      .filter((c) => !(c.type !== 'file' && HIDDEN_DIR_NAMES.has(c.name)))
      .map(filterHiddenDirs),
  }
}

/** 子目录条目 → 树节点（目录 children 未加载=undefined，文件为叶子）。 */
function entriesToNodes(entries: FileEntry[], parentPath: string): TreeNode[] {
  const prefix = parentPath === '.' ? '' : `${parentPath}/`
  return entries.map((e) => ({
    name: e.name,
    path: `${prefix}${e.name}`,
    type: e.type,
    ...(e.ignored ? { ignored: true } : {}),
    ...(e.type === 'directory' ? { children: undefined } : {}),
  }))
}

/** 不可变更新：把 dirPath 节点的 children 设为 nodes。 */
function setChildren(root: TreeNode, dirPath: string, nodes: TreeNode[]): TreeNode {
  if (root.path === dirPath) return { ...root, children: nodes }
  if (!root.children) return root
  return { ...root, children: root.children.map((c) => setChildren(c, dirPath, nodes)) }
}

/** 不可变移除：从树中删除 path 节点。 */
function removeNode(root: TreeNode, path: string): TreeNode {
  if (!root.children) return root
  return {
    ...root,
    children: root.children.filter((c) => c.path !== path).map((c) => removeNode(c, path)),
  }
}

/** 收集 path 的祖先目录路径（不含自身）：a/b/c → ['a','a/b']。 */
function ancestorsOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

export function FileBrowser({
  projectId,
  onPick,
  onDelete,
}: {
  projectId: string
  onPick: (path: string) => void
  onDelete?: (path: string) => void
}) {
  const { data: projects } = useProjects()
  const projectName = projects?.find((p) => p.id === projectId)?.name ?? projectId
  const fileRef = useFileReference()

  const [treeRoot, setTreeRoot] = useState<TreeNode | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  /** 懒加载子目录失败的原因（path → message）。失败不再静默：此前 catch 只留了
   *  一句注释，目录随后仍被标记为已展开并在树里渲染「（空）」，用户据此认定
   *  该目录是空的。 */
  const [loadErrors, setLoadErrors] = useState<Map<string, string>>(new Map())
  /** 根目录列目录失败的原因（null=正常）。空串表示失败但没有 message。 */
  const [rootError, setRootError] = useState<string | null>(null)
  /** 根目录重试令牌：自增触发上面那个 effect 重跑。 */
  const [rootReload, setRootReload] = useState(0)
  const [query, setQuery] = useState('')
  /** P3：搜索输入 300ms 防抖——服务端 /api/files/search 是全仓递归扫描，
   *  此前每击键触发一次全量 walk，大仓库明显卡顿。 */
  const [searchDebounced, setSearchDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(query), 300)
    return () => clearTimeout(t)
  }, [query])
  /** 显示隐藏目录（node_modules/构建产物等），默认降噪过滤。 */
  const [showHidden, setShowHidden] = useState(false)
  /** 待删除的路径（null=无确认弹层）。删除是「移入回收站」的可恢复操作，
   *  用轻量确认而非 DangerConfirmDialog 的逐字确认。 */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  /** 删除失败原因（null=未失败）。渲染在确认弹层里，与用户正在做的操作同框可见。 */
  const [deleteError, setDeleteError] = useState<string | null>(null)
  /** 删除请求在飞：锁住确认键与所有关闭出口（关闭会把失败原因一起关掉）。 */
  const [deleting, setDeleting] = useState(false)

  /** 渲染用树：默认过滤忽略目录；memo 保持节点引用稳定，避免全树重渲染。 */
  const visibleRoot = useMemo(
    () => (treeRoot && !showHidden ? filterHiddenDirs(treeRoot) : treeRoot),
    [treeRoot, showHidden],
  )

  // 阈值是 1 而非 2：单字符查询此前被静默丢弃，搜索框里有字、结果却是未
  // 过滤的整棵树，用户只会以为「这个文件搜不到」。实测输入「s」列出的是
  // 项目根目录，输入「se」才真正进入搜索结果。服务端 /api/files/search
  // 对单字符同样正常返回，真正的防抖开销由上面 300ms 承担。
  const isSearch = searchDebounced.length >= 1
  const searchQ = useQuery({
    queryKey: ['files', 'search', searchDebounced, projectId],
    queryFn: () => fileAPI.search(searchDebounced, projectId),
    enabled: isSearch,
  })
  const refetchSearch = searchQ.refetch

  // git 状态：项目打开时拉取，30s 自动刷新（文件树高亮用）
  const gitStatusQ = useQuery({
    queryKey: ['files', 'git-status', projectId],
    queryFn: () => fileAPI.gitStatus(projectId),
    refetchInterval: 30_000,
  })
  const gitStatusMap: GitStatusMap | undefined = gitStatusQ.data

  /**
   * 树世代：切换项目时自增。在途的懒加载请求按世代校验后才允许落盘——否则上一个
   * 项目的目录列表会并进新项目的树：dirPath 是项目内相对路径（'src'），两边同名
   * 目录合并「恰好成功」、不报任何错，而 handleToggle 只在 children === undefined
   * 时才加载，于是这份外来清单被永久缓存到刷新为止，点进去还是按新项目读同路径
   * 文件——看到的是另一个仓库的内容。
   */
  const treeGenRef = useRef(0)

  // 切换项目时重置树，加载新项目根目录
  // biome-ignore lint/correctness/useExhaustiveDependencies: rootReload 是重试令牌——重试按钮自增它来重跑这次加载，effect 体里不读它
  useEffect(() => {
    let cancelled = false
    // 世代号先自增：在途的懒加载请求返回时据此刻号认领自己的世代，一律丢弃。
    treeGenRef.current += 1
    setTreeRoot(null)
    setExpanded(new Set())
    setLoadingPaths(new Set())
    setLoadErrors(new Map())
    setRootError(null)
    // 搜索词只对上一个项目成立：不复位的话，切项目后面板仍停在「搜索结果」分支，
    // 用上一个项目的词去搜新项目，命中不到就显示「无匹配文件」——用户据此判定
    // 新项目里没有这个文件（侧栏会话搜索已按同一口径复位，文件面板此前漏了）。
    setQuery('')
    setSearchDebounced('')
    // 删除确认弹层同样必须跟着项目走：confirmDelete 用的是**当前** projectId，
    // 弹层里写的却是上一个项目里的路径。切项目（顶栏项目下拉、浏览器后退/前进，
    // 都是同一 /projects/:projectId 子树复用）后确认一次，删掉的就是新项目里的
    // 同路径文件；失败原因（deleteError）也只对上一条路径成立。
    setPendingDelete(null)
    setDeleteError(null)
    fileAPI
      .list('.', projectId)
      .then((entries) => {
        if (cancelled) return
        setTreeRoot({
          name: projectName,
          path: '.',
          type: 'directory',
          children: entriesToNodes(entries, '.'),
        })
      })
      .catch((err: unknown) => {
        // 失败必须落到可见错误态：此前 .catch(() => {}) 让 treeRoot 恒为 null，
        // 面板永远停在「加载中…」，用户只能反复刷新整页（见下方 rootError 分支）。
        if (cancelled) return
        setRootError(
          (err as { message?: string } | null)?.message ??
            (err instanceof Error ? err.message : null),
        )
      })
    return () => {
      cancelled = true
    }
  }, [projectId, projectName, rootReload])

  /** 懒加载某个目录的子项（失败落到 loadErrors，可就地重试）。 */
  const loadChildren = useCallback(
    async (dirPath: string) => {
      const gen = treeGenRef.current
      setLoadingPaths((prev) => new Set(prev).add(dirPath))
      setLoadErrors((prev) => {
        if (!prev.has(dirPath)) return prev
        const next = new Map(prev)
        next.delete(dirPath)
        return next
      })
      try {
        const entries = await fileAPI.list(dirPath, projectId)
        // 世代已变（期间切换了项目）：这份列表属于上一个项目，丢弃。
        if (gen !== treeGenRef.current) return
        setTreeRoot((prev) =>
          prev ? setChildren(prev, dirPath, entriesToNodes(entries, dirPath)) : prev,
        )
      } catch (err) {
        if (gen !== treeGenRef.current) return
        // APIError 是结构体而非 Error 子类，必须结构化取 message
        // （同上方 rootError / searchErrorMessage 口径）。
        setLoadErrors((prev) =>
          new Map(prev).set(
            dirPath,
            (err as { message?: string } | null)?.message ??
              (err instanceof Error ? err.message : null) ??
              '无法读取该目录',
          ),
        )
      } finally {
        setLoadingPaths((prev) => {
          const next = new Set(prev)
          next.delete(dirPath)
          return next
        })
      }
    },
    [projectId],
  )

  const handleToggle = useCallback(
    async (dirPath: string) => {
      // 折叠已展开目录
      if (expanded.has(dirPath)) {
        setExpanded((prev) => {
          const next = new Set(prev)
          next.delete(dirPath)
          return next
        })
        return
      }
      // 首次展开：懒加载子目录
      const needLoad = treeRoot ? findNode(treeRoot, dirPath)?.children === undefined : false
      if (needLoad) {
        const gen = treeGenRef.current
        await loadChildren(dirPath)
        // 等待期间切换了项目：展开态已在切换时复位，别把上一个项目的路径写回来。
        if (gen !== treeGenRef.current) return
      }
      setExpanded((prev) => new Set(prev).add(dirPath))
    },
    [expanded, treeRoot, loadChildren],
  )

  const handleSelect = useCallback(
    (path: string) => {
      // 文件节点 → 打开；目录由 directoryClickMode=toggle 处理展开，不会走到这
      onPick(path)
    },
    [onPick],
  )

  /** 目录加载失败后就地重试（树里的失败态按钮）。 */
  const retryLoad = useCallback(
    (path: string) => {
      void loadChildren(path)
    },
    [loadChildren],
  )

  const requestDelete = useCallback((path: string) => {
    setDeleteError(null)
    setPendingDelete(path)
  }, [])

  const closeDeleteDialog = useCallback(() => {
    if (deleting) return
    setPendingDelete(null)
    setDeleteError(null)
  }, [deleting])

  const confirmDelete = useCallback(async () => {
    const path = pendingDelete
    if (!path) return
    setDeleting(true)
    setDeleteError(null)
    try {
      // 发起前记下树世代：删除请求在途时可能切了项目（确认弹层虽随切换关闭，
      // 本函数已在途）。path 是项目内相对路径，成功后无条件落地会把**新项目**
      // 树里的同路径节点一并抹掉、并对新项目触发 onDelete——用户在 A 项目删
      // 文件，B 项目的同名文件却从界面消失。
      const gen = treeGenRef.current
      await fileAPI.delete(path, projectId)
      // 世代已变（删除在途时切换了项目）：落盘发生在旧项目，树更新与回调只该
      // 属于旧项目，对新项目一律不落地。
      if (gen !== treeGenRef.current) return
      setTreeRoot((prev) => (prev ? removeNode(prev, path) : prev))
      onDelete?.(path)
      if (isSearch) refetchSearch()
      gitStatusQ.refetch()
      setPendingDelete(null)
    } catch (err) {
      // 失败原因必须可见：此前是 window.alert('删除失败，请重试')，后端的
      // 「File not found / EACCES / EPERM / ENOTEMPTY」等真实原因被整句丢掉，
      // 用户只能对同一路径反复点删除。APIError 是结构体而非 Error 子类，
      // 必须结构化取 message（同上方 rootError/searchErrorMessage 口径）。
      setDeleteError(
        (err as { message?: string } | null)?.message ??
          (err instanceof Error ? err.message : null) ??
          '删除失败，请重试。',
      )
    } finally {
      setDeleting(false)
    }
  }, [pendingDelete, projectId, onDelete, isSearch, refetchSearch, gitStatusQ])

  const searchEntries: FileSearchResult[] = isSearch ? (searchQ.data ?? []) : []
  // APIError 是结构体而非 Error 子类，必须结构化取 message（同 KanbanView/FilePreview 口径）。
  const searchErrorMessage =
    (searchQ.error as { message?: string } | null)?.message ??
    (searchQ.error instanceof Error ? searchQ.error.message : null)

  /**
   * 搜索结果里点目录 → 回到文件树并展开定位到该目录。
   *
   * 此前目录行与文件行走同一条 onPick（打开预览），而读接口对目录执行
   * readFile 抛 EISDIR → 404：搜索结果里点文件夹必然得到「文件读取失败 /
   * File not found」，同一路径在树里点却是展开语义。
   */
  const handleReveal = useCallback(
    async (dirPath: string) => {
      setQuery('')
      // 祖先按由浅到深加载：深层目录的 children 挂在尚未拉取的父节点下，
      // 顺序反了 setChildren 找不到目标，展开后仍是空的。
      const chain = ancestorsOf(dirPath)
      setExpanded((prev) => {
        const next = new Set(prev)
        for (const p of chain) next.add(p)
        next.add(dirPath)
        return next
      })
      // reveal 循环持有的是**发起时**的 loadChildren 闭包（内部固定发起时的
      // projectId），迭代之间又隔着 await，「切项目」正好插进循环中间：上一次
      // loadChildren 的清单因世代不符被丢弃（它的 gen 是发起时捕获的），循环却
      // 继续走到下一层目录——这一次 loadChildren 是切换**之后**才调用的，内部
      // 读到的已是新世代、响应落地校验通过，旧 projectId 拉来的目录清单于是写进
      // 新项目的树并被缓存（handleToggle 只在 children === undefined 时加载，
      // 这份外来清单就此钉死到刷新为止）。故每次 await 后比对世代，不符即终止
      // 整条 reveal 链。
      for (const dir of [...chain, dirPath]) {
        if (treeRoot && findNode(treeRoot, dir)?.children === undefined) {
          const gen = treeGenRef.current
          await loadChildren(dir)
          // 等待期间切换了项目：后续祖先/目标目录的加载属于上一个项目，不再继续。
          if (gen !== treeGenRef.current) return
        }
      }
    },
    [treeRoot, loadChildren],
  )

  return (
    <div className={panel}>
      <div className={headerBar}>
        <SyncedInput
          className={searchInputFlex}
          placeholder="搜索文件…"
          /* 显式名称而非只靠 placeholder：placeholder 只是视觉提示（HTML-AAM 会在名称
           * 为空时拿它兜底，但那是脆弱的名字来源），读屏/语音控制依赖稳定字段名，
           * 且多个无 label 搜索框并列时无法区分。 */
          aria-label="搜索文件"
          value={query}
          onChange={(v) => setQuery(v)}
          data-testid="file-search"
        />
        <button
          type="button"
          className={hiddenToggle}
          aria-pressed={showHidden}
          aria-label="显示隐藏目录"
          title={
            showHidden
              ? '隐藏 node_modules、构建产物等目录'
              : '显示 node_modules、构建产物等隐藏目录'
          }
          data-testid="toggle-hidden-dirs"
          onClick={() => setShowHidden((v) => !v)}
        >
          {showHidden ? '🙈' : '👁'}
        </button>
      </div>
      <div className={treeScroll}>
        {isSearch ? (
          searchQ.isLoading ? (
            <div className={loading}>搜索中…</div>
          ) : searchQ.isError ? (
            // 「查不到」与「搜不了」必须分开：此前没有 error 分支，重试耗尽后
            // data=undefined 直接落进下面的「无匹配文件」——用户据此判定文件不
            // 存在，去重建同名文件或改错位置。APIError 是结构体而非 Error 子类，
            // 必须结构化取 message，否则渲染成 [object Object]。
            <div className={errorState} data-testid="file-search-error" role="alert">
              <span className={errorTitle}>搜索失败</span>
              <span className={errorDetail}>
                {searchErrorMessage ?? '无法完成搜索，请稍后重试。'}
              </span>
              <button
                type="button"
                className={retryBtn}
                data-testid="file-search-retry"
                onClick={() => void refetchSearch()}
              >
                重试
              </button>
            </div>
          ) : searchEntries.length === 0 ? (
            <div className={empty}>无匹配文件</div>
          ) : (
            <ul className={resultList} aria-label="搜索结果">
              {searchEntries.map((e) => (
                <li key={e.path} className={resultItem}>
                  <button
                    type="button"
                    className={resultRow}
                    data-testid={`file-${e.path}`}
                    title={e.type === 'directory' ? '在文件树中定位该目录' : undefined}
                    aria-label={e.type === 'directory' ? `定位目录 ${e.path}` : undefined}
                    onClick={() => (e.type === 'directory' ? handleReveal(e.path) : onPick(e.path))}
                  >
                    <span>{e.type === 'directory' ? '📁' : '📄'}</span>
                    <span>{e.path}</span>
                  </button>
                  {fileRef && (
                    <button
                      type="button"
                      className={searchMentionBtn}
                      data-search-mention
                      data-testid={`search-mention-${e.path}`}
                      aria-label={`引用 ${e.path} 到输入框`}
                      onClick={() => fileRef.insertFileReference(e.path)}
                    >
                      @
                    </button>
                  )}
                  <button
                    type="button"
                    className={searchDeleteBtn}
                    data-search-delete
                    data-testid={`search-delete-${e.path}`}
                    aria-label={`删除 ${e.path}`}
                    onClick={() => requestDelete(e.path)}
                  >
                    🗑
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : rootError !== null ? (
          <div className={errorState} data-testid="file-tree-error" role="alert">
            <span className={errorTitle}>文件加载失败</span>
            <span className={errorDetail}>{rootError || '无法读取项目文件。'}</span>
            <button
              type="button"
              className={retryBtn}
              data-testid="file-tree-retry"
              onClick={() => setRootReload((n) => n + 1)}
            >
              重试
            </button>
          </div>
        ) : !treeRoot ? (
          <div className={loading}>加载中…</div>
        ) : (
          <FileTree
            root={visibleRoot}
            expanded={expanded}
            selected={null}
            loadingPaths={loadingPaths}
            errorPaths={loadErrors}
            onRetryLoad={retryLoad}
            onToggle={handleToggle}
            onSelect={handleSelect}
            directoryClickMode="toggle"
            onMention={fileRef?.insertFileReference}
            onDelete={requestDelete}
            gitStatusMap={gitStatusMap}
            label="项目文件树"
            hideRoot
          />
        )}
      </div>
      {/* 删除确认：原生 window.confirm 是阻塞式系统框（不可样式化、与主题割裂、
          移动端还会被浏览器改写），且失败时只能弹 window.alert 一句「请重试」，
          把后端的真实原因丢掉。改为应用内弹层，失败原因留在同框可见。 */}
      <Dialog
        open={pendingDelete !== null}
        onClose={closeDeleteDialog}
        closeDisabled={deleting}
        title="删除文件"
        testId="file-delete-dialog"
        width="420px"
        footer={
          <>
            <button
              type="button"
              className={btnSm}
              data-testid="file-delete-cancel"
              disabled={deleting}
              onClick={closeDeleteDialog}
            >
              取消
            </button>
            <button
              type="button"
              className={`${btnSm} ${btnDanger}`}
              data-testid="file-delete-confirm"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting ? '删除中…' : '删除'}
            </button>
          </>
        }
      >
        <p className={confirmText}>
          {`确定删除「${pendingDelete ?? ''}」？文件将移入系统回收站，可从回收站恢复。`}
        </p>
        {deleteError ? (
          <div className={confirmError} role="alert" data-testid="file-delete-error">
            <span className={errorTitle}>删除失败</span>
            <span className={errorDetail}>{deleteError}</span>
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}

/** 在树中按 path 查找节点。 */
function findNode(node: TreeNode | null, path: string): TreeNode | null {
  if (!node) return null
  if (node.path === path) return node
  if (!node.children) return null
  for (const c of node.children) {
    const found = findNode(c, path)
    if (found) return found
  }
  return null
}
