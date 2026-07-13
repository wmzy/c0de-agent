import { css } from '@linaria/core'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
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

const commitBar = css`
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 8px 0;
`

const branchLabel = css`
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  & svg {
    flex-shrink: 0;
  }
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

const commitBtn = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
  &:hover {
    border-color: var(--primary);
    color: var(--primary);
  }
  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`

const commitBtnActive = css`
  background: var(--warning);
  border-color: var(--warning);
  color: #fff;
  font-weight: 600;
  animation: pulse 2s ease-in-out infinite;
  &:hover {
    background: var(--warning);
    color: #fff;
    opacity: 0.9;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.85;
    }
  }
`

const commitBtnSuccess = css`
  background: var(--success);
  border-color: var(--success);
  color: #fff;
`

const commitBtnError = css`
  background: var(--error);
  border-color: var(--error);
  color: #fff;
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

const resultRowWrap = css`
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

const searchMentionBtn = css`
  opacity: 0;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
  padding: 0 5px;
  min-height: auto;
  min-width: auto;
  flex-shrink: 0;
  transition: opacity 0.1s;
  &:hover {
    color: var(--primary);
    border-color: var(--primary);
  }
`

const searchDeleteBtn = css`
  opacity: 0;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  padding: 0 5px;
  min-height: auto;
  min-width: auto;
  flex-shrink: 0;
  transition: opacity 0.1s;
  &:hover {
    color: var(--error);
    border-color: var(--error);
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
    children: root.children
      .filter((c) => c.path !== path)
      .map((c) => removeNode(c, path)),
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

  // 当前分支名
  const gitBranchQ = useQuery({
    queryKey: ['files', 'git-branch', projectId],
    queryFn: () => fileAPI.gitBranch(projectId),
    refetchInterval: 30_000,
  })
  const branchName = gitBranchQ.data?.branch ?? null

  // 一键提交：有变更时按钮高亮，点击调用便宜模型生成 commit message 并提交
  const hasChanges =
    !!gitStatusMap &&
    Object.values(gitStatusMap).some((c) => c !== 'ignored')
  const [commitFeedback, setCommitFeedback] = useState<
    { kind: 'idle' } | { kind: 'ok'; message: string } | { kind: 'err'; msg: string }
  >({ kind: 'idle' })

  const commitMut = useMutation({
    mutationFn: () => fileAPI.gitCommit(projectId),
    onMutate: () => setCommitFeedback({ kind: 'idle' }),
    onSuccess: (data) => {
      setCommitFeedback({ kind: 'ok', message: data.message })
      gitStatusQ.refetch()
      setTimeout(
        () => setCommitFeedback((s) => (s.kind === 'ok' ? { kind: 'idle' } : s)),
        3000,
      )
    },
    onError: (err: unknown) => {
      const msg =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: string }).message)
          : '提交失败'
      setCommitFeedback({ kind: 'err', msg })
      setTimeout(
        () => setCommitFeedback((s) => (s.kind === 'err' ? { kind: 'idle' } : s)),
        5000,
      )
    },
  })

  const commitBtnClass = (() => {
    if (commitMut.isPending) return commitBtn
    if (commitFeedback.kind === 'ok') return `${commitBtn} ${commitBtnSuccess}`
    if (commitFeedback.kind === 'err') return `${commitBtn} ${commitBtnError}`
    if (hasChanges) return `${commitBtn} ${commitBtnActive}`
    return commitBtn
  })()

  const commitLabel = (() => {
    if (commitMut.isPending) return '提交中…'
    if (commitFeedback.kind === 'ok') return '✓ 已提交'
    if (commitFeedback.kind === 'err') return '提交失败'
    return '提交'
  })()

  const commitTitle = (() => {
    if (commitFeedback.kind === 'ok') return commitFeedback.message
    if (commitFeedback.kind === 'err') return commitFeedback.msg
    return hasChanges ? 'AI 生成 commit message 并提交全部变更' : '无变更'
  })()

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
      <div className={commitBar}>
        <span className={branchLabel} data-testid="git-branch-label">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.371A2.25 2.25 0 019.5 3.25zM4.25 2.5a.75.75 0 000 1.5.75.75 0 000-1.5zM2 3.25a2.25 2.25 0 113 2.122v5.256a2.25 2.25 0 11-1.5 0V5.371A2.25 2.25 0 014.25 3.25z" />
          </svg>
          {branchName ?? '(非 git 仓库)'}
        </span>
        <button
          type="button"
          className={commitBtnClass}
          onClick={() => commitMut.mutate()}
          disabled={commitMut.isPending || !hasChanges}
          title={commitTitle}
          data-testid="git-commit-btn"
          data-has-changes={hasChanges || undefined}
        >
          {commitLabel}
        </button>
      </div>
      <div className={headerBar}>
        <input
          className={searchInputFlex}
          placeholder="搜索文件…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="file-search"
        />
      </div>
      <div className={treeScroll}>
        {isSearch ? (
          searchQ.isLoading ? (
            <div className={loading}>搜索中…</div>
          ) : searchEntries.length === 0 ? (
            <div className={empty}>无匹配文件</div>
          ) : (
            searchEntries.map((e) => (
              <div key={e.path} className={resultRowWrap}>
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
              </div>
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
            onMention={fileRef?.insertFileReference}
            onDelete={handleDelete}
            gitStatusMap={gitStatusMap}
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
