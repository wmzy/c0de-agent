import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { FileTree, type TreeNode } from '../components/FileTree.js'
import { useProjects } from '../hooks/useSession.js'
import { fileAPI } from '../services/file.js'
import type { FileEntry, FileSearchResult } from '../types/index.js'

const panel = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`

const searchInput = css`
  margin: 8px;
  padding: 6px 8px;
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
  width: 100%;
  padding: 4px 8px;
  cursor: pointer;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  text-align: left;
  &:hover {
    background: var(--bg-secondary);
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

/** 子目录条目 → 树节点（目录 children 未加载=undefined，文件为叶子）。 */
function entriesToNodes(entries: FileEntry[], parentPath: string): TreeNode[] {
  const prefix = parentPath === '.' ? '' : `${parentPath}/`
  return entries.map((e) => ({
    name: e.name,
    path: `${prefix}${e.name}`,
    type: e.type,
    ...(e.type === 'directory' ? { children: undefined } : {}),
  }))
}

/** 不可变更新：把 dirPath 节点的 children 设为 nodes。 */
function setChildren(root: TreeNode, dirPath: string, nodes: TreeNode[]): TreeNode {
  if (root.path === dirPath) return { ...root, children: nodes }
  if (!root.children) return root
  return { ...root, children: root.children.map((c) => setChildren(c, dirPath, nodes)) }
}

export function FileBrowser({
  projectId,
  onPick,
}: {
  projectId: string
  onPick: (path: string) => void
}) {
  const { data: projects } = useProjects()
  const projectName = projects?.find((p) => p.id === projectId)?.name ?? projectId

  const [treeRoot, setTreeRoot] = useState<TreeNode | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')

  const isSearch = query.length > 1
  const searchQ = useQuery({
    queryKey: ['files', 'search', query, projectId],
    queryFn: () => fileAPI.search(query, projectId),
    enabled: isSearch,
  })

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
      const needLoad =
        treeRoot
          ? findNode(treeRoot, dirPath)?.children === undefined
          : false
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

  const searchEntries: FileSearchResult[] = isSearch ? (searchQ.data ?? []) : []

  return (
    <div className={panel}>
      <input
        className={searchInput}
        placeholder="搜索文件…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-testid="file-search"
      />
      <div className={treeScroll}>
        {isSearch ? (
          searchQ.isLoading ? (
            <div className={loading}>搜索中…</div>
          ) : searchEntries.length === 0 ? (
            <div className={empty}>无匹配文件</div>
          ) : (
            searchEntries.map((e) => (
              <button
                key={e.path}
                type="button"
                className={resultRow}
                data-testid={`file-${e.path}`}
                onClick={() => onPick(e.path)}
              >
                <span>{e.type === 'directory' ? '📁' : '📄'}</span>
                <span>{e.path}</span>
              </button>
            ))
          )
        ) : !treeRoot ? (
          <div className={loading}>加载中…</div>
        ) : (
          <FileTree
            root={treeRoot}
            expanded={expanded}
            selected={null}
            loadingPaths={loadingPaths}
            onToggle={handleToggle}
            onSelect={handleSelect}
            directoryClickMode="toggle"
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
