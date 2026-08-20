import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileTree, type TreeNode } from '../components/FileTree.js'
import { useFileReference } from '../contexts/ReferenceContext.js'
import { useProjects } from '../hooks/useSession.js'
import { fileAPI } from '../services/file.js'
import type { FileEntry, FileSearchResult, GitStatusMap } from '../types/index.js'

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
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  &:focus {
    outline: none;
    border-color: var(--primary);
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
  color: var(--text);
  font-size: 12.5px;
  text-align: left;
  &:hover {
    background: var(--bg-secondary);
  }
`

const searchMentionBtn = css`
  opacity: 0.65;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--text-secondary);
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
    color: var(--primary);
  }
`

const searchDeleteBtn = css`
  opacity: 0.65;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--text-secondary);
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
    color: var(--error);
  }
`

const empty = css`
  padding: 12px 8px;
  color: var(--text-secondary);
  font-size: 12px;
`

const loading = css`
  padding: 12px 8px;
  color: var(--text-secondary);
  font-size: 12px;
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
    border-color: var(--primary);
    color: var(--primary);
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
  const [query, setQuery] = useState('')
  /** 显示隐藏目录（node_modules/构建产物等），默认降噪过滤。 */
  const [showHidden, setShowHidden] = useState(false)

  /** 渲染用树：默认过滤忽略目录；memo 保持节点引用稳定，避免全树重渲染。 */
  const visibleRoot = useMemo(
    () => (treeRoot && !showHidden ? filterHiddenDirs(treeRoot) : treeRoot),
    [treeRoot, showHidden],
  )

  const isSearch = query.length > 1
  const searchQ = useQuery({
    queryKey: ['files', 'search', query, projectId],
    queryFn: () => fileAPI.search(query, projectId),
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

  // 切换项目时重置树，加载新项目根目录
  useEffect(() => {
    let cancelled = false
    setTreeRoot(null)
    setExpanded(new Set())
    setLoadingPaths(new Set())
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
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectId, projectName])

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
        setLoadingPaths((prev) => new Set(prev).add(dirPath))
        try {
          const entries = await fileAPI.list(dirPath, projectId)
          setTreeRoot((prev) =>
            prev ? setChildren(prev, dirPath, entriesToNodes(entries, dirPath)) : prev,
          )
        } catch {
          /* 加载失败保留未展开态 */
        } finally {
          setLoadingPaths((prev) => {
            const next = new Set(prev)
            next.delete(dirPath)
            return next
          })
        }
      }
      setExpanded((prev) => new Set(prev).add(dirPath))
    },
    [expanded, treeRoot, projectId],
  )

  const handleSelect = useCallback(
    (path: string) => {
      // 文件节点 → 打开；目录由 directoryClickMode=toggle 处理展开，不会走到这
      onPick(path)
    },
    [onPick],
  )

  const handleDelete = useCallback(
    async (path: string) => {
      if (!window.confirm(`确定删除「${path}」？文件将移入系统回收站，可从回收站恢复。`)) return
      try {
        await fileAPI.delete(path, projectId)
        setTreeRoot((prev) => (prev ? removeNode(prev, path) : prev))
        onDelete?.(path)
        if (isSearch) refetchSearch()
        gitStatusQ.refetch()
      } catch {
        window.alert('删除失败，请重试')
      }
    },
    [projectId, onDelete, isSearch, refetchSearch, gitStatusQ],
  )

  const searchEntries: FileSearchResult[] = isSearch ? (searchQ.data ?? []) : []

  return (
    <div className={panel}>
      <div className={headerBar}>
        <input
          className={searchInputFlex}
          placeholder="搜索文件…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
                    onClick={() => onPick(e.path)}
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
                    onClick={() => handleDelete(e.path)}
                  >
                    🗑
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : !treeRoot ? (
          <div className={loading}>加载中…</div>
        ) : (
          <FileTree
            root={visibleRoot}
            expanded={expanded}
            selected={null}
            loadingPaths={loadingPaths}
            onToggle={handleToggle}
            onSelect={handleSelect}
            directoryClickMode="toggle"
            onMention={fileRef?.insertFileReference}
            onDelete={handleDelete}
            gitStatusMap={gitStatusMap}
            label="项目文件树"
            hideRoot
          />
        )}
      </div>
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
