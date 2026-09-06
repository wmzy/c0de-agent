import { css } from '@linaria/core'
import type { Session } from '@shared/types/message.js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import { BranchTree } from '../components/BranchTree.js'
import {
  useDeletedSessions,
  useDeleteSession,
  useRestoreSession,
  useSessionTree,
} from '../hooks/useSession.js'
import { sessionAPI } from '../services/session.js'
import type { SessionTreeNode } from '../types/index.js'

const panel = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`

const header = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--border);
`

const searchInput = css`
  margin: 8px 12px 0;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  min-height: auto;
  width: auto;
`

const trashHint = css`
  color: var(--text-secondary);
  font-size: 11px;
  flex-shrink: 0;
`

const addBtn = css`
  flex-shrink: 0;
  min-height: auto;
  min-width: auto;
  padding: 4px 8px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  &:hover {
    border-color: var(--primary);
    color: var(--primary);
  }
`

const recycleBtn = css`
  flex-shrink: 0;
  min-height: auto;
  min-width: auto;
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  &[aria-pressed='true'] {
    color: var(--primary);
    border-color: var(--primary);
  }
`

const empty = css`
  padding: 16px 12px;
  color: var(--text);
  opacity: 0.6;
  font-size: 13px;
  text-align: center;
`

const errorBar = css`
  padding: 6px 12px;
  font-size: 12px;
  color: var(--error);
  border-bottom: 1px solid var(--border);
`

const noticeBar = css`
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
`

const deletedRow = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--text);
  border-bottom: 1px solid var(--border);

  & > span:first-child {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  & > span:nth-child(2) {
    color: var(--text-secondary);
    font-size: 11px;
    flex-shrink: 0;
  }
`

const restoreBtn = css`
  flex-shrink: 0;
  min-height: auto;
  min-width: auto;
  padding: 2px 8px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--primary);
  cursor: pointer;
  &:hover {
    border-color: var(--primary);
  }
`

/* P2-6 内容匹配区：标题树下方平铺的消息内容命中行 */
const matchSection = css`
  padding: 4px 12px 8px;
  border-top: 1px solid var(--border);
`

const matchHeader = css`
  font-size: 11px;
  color: var(--text-secondary);
  padding: 4px 0;
`

const matchRow = css`
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: auto;
  padding: 5px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  &:hover {
    background: var(--bg-secondary);
  }
`

const matchIcon = css`
  flex-shrink: 0;
  font-size: 12px;
`

const matchTitle = css`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

/** 按项目 id 过滤会话树（以根会话的 projectId 为准）。项目为路由顶级维度，仅显示归属本项目的会话。 */
function filterTree(tree: SessionTreeNode[], projectId: string): SessionTreeNode[] {
  return tree.filter((node) => node.session.projectId === projectId)
}

/** 在树中按 id 查找节点（深度优先）。 */
function findNode(nodes: SessionTreeNode[], id: string): SessionTreeNode | null {
  for (const node of nodes) {
    if (node.session.id === id) return node
    const found = findNode(node.children ?? [], id)
    if (found) return found
  }
  return null
}

/** 统计某节点的 fork 后代数量（含各级子孙；软删除级联范围）。 */
function countDescendants(node: SessionTreeNode): number {
  let n = 0
  for (const child of node.children ?? []) {
    n += 1 + countDescendants(child)
  }
  return n
}

/** 按标题搜索过滤会话树：保留命中节点及其祖先；命中节点的子树原样保留。 */
function searchTree(nodes: SessionTreeNode[], q: string): SessionTreeNode[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return nodes
  const out: SessionTreeNode[] = []
  for (const node of nodes) {
    const selfHit = node.session.title.toLowerCase().includes(needle)
    const children = searchTree(node.children ?? [], q)
    if (selfHit) {
      out.push({ ...node, children: node.children ?? [] })
    } else if (children.length > 0) {
      out.push({ ...node, children })
    }
  }
  return out
}

export function SessionList({
  projectId,
  activeId,
  onSelect,
  onNewSession,
  onDeleted,
}: {
  projectId: string
  activeId: string | null
  onSelect: (id: string) => void
  /** 新建会话：仅前端导航到草稿页，不创建会话（首条消息发送时才创建）。 */
  onNewSession: () => void
  /** 删除会话后回调（参数为被删 id），用于父级在删除当前会话时跳回草稿页。 */
  onDeleted?: (id: string) => void
}) {
  const { data: tree, isLoading } = useSessionTree()
  const del = useDeleteSession()
  const qc = useQueryClient()

  /** P2-5：重命名会话（成功后刷新会话树）。 */
  const handleRename = async (id: string, title: string): Promise<boolean> => {
    try {
      await sessionAPI.rename(id, title)
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ['sessions', 'tree'] })
      return true
    } catch (err) {
      // P3：重命名失败此前写入 deleteError，错误条误显示「删除失败」前缀。
      setRenameError(err instanceof Error ? err.message : '重命名失败')
      return false
    }
  }
  const [showRecycle, setShowRecycle] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [importNotice, setImportNotice] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [search, setSearch] = useState('')
  // P2-6：跨会话内容搜索的防抖词（用户停止输入 300ms 后触发服务端查询）
  const [searchDebounced, setSearchDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const visibleTree = tree ? searchTree(filterTree(tree, projectId), search) : []

  // P2-6：标题未命中时再搜消息内容（标题树之外的补充结果）。
  const { data: contentMatches } = useQuery({
    queryKey: ['sessions', 'search', projectId, searchDebounced],
    queryFn: () => sessionAPI.search(searchDebounced, projectId),
    enabled: searchDebounced.length > 1,
    staleTime: 10_000,
  })
  const visibleIds = useMemo(() => {
    const ids = new Set<string>()
    for (const n of visibleTree) {
      ids.add(n.session.id)
      for (const c of n.children ?? []) ids.add(c.session.id)
    }
    return ids
  }, [visibleTree])
  const extraMatches = useMemo(
    () =>
      (contentMatches?.results ?? []).filter(
        (r) => r.matchedBy === 'content' && !visibleIds.has(r.session.id),
      ),
    [contentMatches, visibleIds],
  )

  const handleDelete = (id: string) => {
    setDeleteError(null)
    // fail-closed：confirm 不可用时宁可阻止删除（不可恢复操作），与 FileBrowser 惯例一致
    const node = findNode(visibleTree, id)
    const branches = node ? countDescendants(node) : 0
    const branchNote =
      branches > 0 ? `其 ${branches} 个派生会话（分支/子任务）将一并移入回收站。` : ''
    if (!window.confirm(`删除该会话及其全部消息？${branchNote}将移入回收站，30 天内可恢复。`))
      return
    del.mutate(id, {
      onSuccess: () => onDeleted?.(id),
      onError: (e: unknown) => {
        setDeleteError(e instanceof Error ? e.message : String(e))
      },
    })
  }

  /** 导入会话导出 JSON：成功后刷新会话树并跳转到导入的会话。
   *  flattened 提示（P2）：原会话的分支树结构被扁平化为独立根会话。 */
  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复选择同一文件
    if (!file) return
    setImportError(null)
    setImportNotice(null)
    setImporting(true)
    try {
      const data = JSON.parse(await file.text()) as unknown
      const result = await sessionAPI.importSession(data, projectId)
      await qc.invalidateQueries({ queryKey: ['sessions'] })
      await qc.invalidateQueries({ queryKey: ['sessions', 'tree'] })
      if (result.flattened) {
        setImportNotice('已导入：原会话的分支树结构无法随迁，已作为独立会话导入。')
      }
      onSelect(result.sessionId)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className={panel}>
      <div className={header}>
        <span>会话</span>
        <button
          type="button"
          className={recycleBtn}
          aria-pressed={showRecycle}
          onClick={() => {
            setShowRecycle((v) => !v)
            setDeleteError(null)
          }}
          data-testid="recycle-toggle"
        >
          回收站
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => void handleImportFile(e)}
          data-testid="session-import-input"
        />
        <button
          type="button"
          className={addBtn}
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
          title="导入之前导出的会话 JSON（.c0de-session.json）"
          data-testid="session-import"
        >
          {importing ? '导入中…' : '导入'}
        </button>
        <button type="button" className={addBtn} onClick={onNewSession} data-testid="new-session">
          + 新建
        </button>
      </div>
      {deleteError && (
        <div className={errorBar} data-testid="delete-error">
          删除失败：{deleteError}
        </div>
      )}
      {renameError && (
        <div className={errorBar} data-testid="rename-error">
          重命名失败：{renameError}
        </div>
      )}
      {importError && (
        <div className={errorBar} data-testid="import-error">
          导入失败：{importError}
        </div>
      )}
      {importNotice && (
        <div className={noticeBar} data-testid="import-notice">
          {importNotice}
        </div>
      )}
      {!showRecycle && (
        <input
          className={searchInput}
          type="search"
          placeholder="搜索会话标题或消息内容…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="session-search"
        />
      )}
      {isLoading && !showRecycle ? <div className={empty}>加载中…</div> : null}
      {!showRecycle ? (
        <>
          {!isLoading && visibleTree.length === 0 && extraMatches.length === 0 ? (
            <div className={empty}>
              {search
                ? '无匹配会话（CLI 会话不在 Web 会话树中，可用 `c0de sessions list` 查看）'
                : '该项目下暂无会话'}
            </div>
          ) : null}
          {visibleTree.length > 0 && (
            <BranchTree
              nodes={visibleTree}
              activeId={activeId}
              onSelect={onSelect}
              onDelete={handleDelete}
              onRename={handleRename}
            />
          )}
          {/* P2-6：标题未命中、消息内容命中的会话 */}
          {extraMatches.length > 0 && (
            <div className={matchSection}>
              <div className={matchHeader}>消息内容匹配</div>
              {extraMatches.map((r) => (
                <button
                  key={r.session.id}
                  type="button"
                  className={matchRow}
                  onClick={() => onSelect(r.session.id)}
                  data-testid={`content-match-${r.session.id}`}
                  title={r.session.title}
                >
                  <span className={matchIcon}>🔎</span>
                  <span className={matchTitle}>{r.session.title}</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <RecycleBin projectId={projectId} />
      )}
    </div>
  )
}

/** 回收站保留期（与后端 purgeDeletedSessions 默认 30 天一致，仅展示用）。 */
const TRASH_RETENTION_DAYS = 30

/** 剩余保留天数（负数视为 0：即将被后台清理）。 */
function daysLeft(deletedAt: number | null | undefined): number {
  if (!deletedAt) return TRASH_RETENTION_DAYS
  const ms = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000 - (Date.now() - deletedAt)
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)))
}

/** 回收站列表：软删除会话 + 恢复/彻底删除按钮 + 清空回收站。
 *  父会话也在回收站的行做标记（恢复时连带还原祖先链）。
 *  P1-7：仅显示当前项目的删除会话；「清空」仅清空当前项目。 */
function RecycleBin({ projectId }: { projectId: string }) {
  const { data: deleted, isLoading } = useDeletedSessions(projectId)
  const restore = useRestoreSession()
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  // P1 可达性：恢复结果反馈（重新归属项目 / 项目目录缺失的孤儿状态）
  const [notice, setNotice] = useState<string | null>(null)
  // P1-2：当前孤儿会话 id（目录失效且未随 restore 归属成功），提供「归属到当前项目」入口
  const [orphanId, setOrphanId] = useState<string | null>(null)

  // P3：回收站搜索（此前删掉的会话只能逐行翻）——标题+消息内容，服务端搜索。
  const [search, setSearch] = useState('')
  const [searchDebounced, setSearchDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])
  const { data: searchResults } = useQuery({
    queryKey: ['sessions', 'search-deleted', projectId, searchDebounced],
    queryFn: () => sessionAPI.search(searchDebounced, projectId, true),
    enabled: searchDebounced.length > 1,
  })

  const rebindMut = useMutation({
    mutationFn: (id: string) => sessionAPI.rebind(id, projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ['sessions', 'tree'] })
      qc.invalidateQueries({ queryKey: ['sessions', 'deleted'] })
      setNotice(null)
      setOrphanId(null)
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  })

  const removeForever = useMutation({
    mutationFn: (id: string) => sessionAPI.removeForever(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions', 'deleted'] })
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  })

  const emptyTrashMut = useMutation({
    mutationFn: () => sessionAPI.emptyTrash(projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions', 'deleted'] })
      setNotice(null)
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  })

  if (isLoading) return <div className={empty}>加载中…</div>
  if (!deleted || deleted.length === 0) return <div className={empty}>回收站为空</div>

  const deletedIds = new Set(deleted.map((s) => s.id))
  const hasDeletedParent = (s: Session): boolean =>
    s.parentId !== null && deletedIds.has(s.parentId)

  // 搜索态展示搜索结果（仍限制在回收站内）；默认展示完整列表。
  const rows =
    searchDebounced.length > 1 ? (searchResults?.results.map((r) => r.session) ?? []) : deleted

  // P2 子树恢复：统计会话在回收站内的派生后代（任意深度），恢复确认时提示。
  const byParent = new Map<string, Session[]>()
  for (const d of deleted) {
    if (!d.parentId) continue
    const list = byParent.get(d.parentId) ?? []
    list.push(d)
    byParent.set(d.parentId, list)
  }
  const countDescendants = (id: string): number => {
    let n = 0
    const stack = [...(byParent.get(id) ?? [])]
    while (stack.length > 0) {
      const cur = stack.pop()
      if (!cur) continue
      n += 1
      stack.push(...(byParent.get(cur.id) ?? []))
    }
    return n
  }

  const handleRemoveForever = (s: Session) => {
    // fail-closed：彻底删除不可恢复，confirm 不可用时宁可阻止
    if (!window.confirm(`彻底删除「${s.title}」及其派生会话？此操作不可恢复。`)) return
    removeForever.mutate(s.id)
  }

  const handleEmptyTrash = () => {
    if (
      !window.confirm(`清空本项目的回收站将永久删除全部 ${deleted.length} 个会话，不可恢复。确定？`)
    )
      return
    emptyTrashMut.mutate()
  }

  return (
    <div>
      {error && (
        <div className={errorBar} data-testid="restore-error">
          恢复失败：{error}
        </div>
      )}
      {notice && (
        <div className={noticeBar} data-testid="restore-notice">
          <span>{notice}</span>
          {orphanId && (
            <button
              type="button"
              className={restoreBtn}
              onClick={() => rebindMut.mutate(orphanId)}
              disabled={rebindMut.isPending}
              data-testid="rebind-orphan"
              title="把该会话归属到当前项目，之后可在本项目会话列表中打开"
            >
              归属到当前项目
            </button>
          )}
        </div>
      )}
      <div className={deletedRow}>
        <span className={trashHint}>超过 {TRASH_RETENTION_DAYS} 天自动清除</span>
        <button
          type="button"
          className={restoreBtn}
          onClick={handleEmptyTrash}
          disabled={emptyTrashMut.isPending}
          data-testid="empty-trash"
        >
          清空回收站
        </button>
      </div>
      <input
        className={searchInput}
        type="search"
        placeholder="搜索回收站标题或消息内容…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        data-testid="trash-search"
      />
      {rows.length === 0 && searchDebounced.length > 1 ? (
        <div className={empty}>回收站无匹配会话</div>
      ) : null}
      {rows.map((s) => {
        const descendants = countDescendants(s.id)
        return (
          <div key={s.id} className={deletedRow}>
            <span title={s.title}>{s.title}</span>
            {hasDeletedParent(s) && (
              <span
                style={{ color: 'var(--warning)', fontSize: 11, flexShrink: 0 }}
                data-testid={`deleted-parent-${s.id}`}
              >
                父会话已删除（恢复时一并还原）
              </span>
            )}
            <span title={s.deletedAt ? new Date(s.deletedAt).toLocaleString() : ''}>
              {`剩 ${daysLeft(s.deletedAt)} 天`}
            </span>
            <button
              type="button"
              className={restoreBtn}
              onClick={() => {
                // P2 子树恢复：恢复会连带还原派生会话，有后代时确认框明示数量。
                if (
                  descendants > 0 &&
                  !window.confirm(`恢复「${s.title}」？其 ${descendants} 个派生会话将一并恢复。`)
                )
                  return
                restore.mutate(
                  { id: s.id, projectId },
                  {
                    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
                    onSuccess: (d) => {
                      setError(null)
                      if (d?.orphaned) {
                        setNotice(`「${s.title}」已恢复，但原项目目录已不存在，会话未归属任何项目`)
                        setOrphanId(s.id)
                      } else if (d?.rebound) {
                        setNotice(`「${s.title}」已恢复并重新归属到项目`)
                        setOrphanId(null)
                      } else {
                        setNotice(null)
                        setOrphanId(null)
                      }
                    },
                  },
                )
              }}
              data-testid={`restore-${s.id}`}
            >
              恢复
            </button>
            <button
              type="button"
              className={restoreBtn}
              style={{ color: 'var(--error)' }}
              onClick={() => handleRemoveForever(s)}
              disabled={removeForever.isPending}
              data-testid={`remove-forever-${s.id}`}
              title="彻底删除，不可恢复"
            >
              彻底删除
            </button>
          </div>
        )
      })}
    </div>
  )
}
