import { css } from '@linaria/core'
import type { Session } from '@shared/types/message.js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { DangerConfirmDialog } from '@/components/DangerConfirmDialog.js'
import {
  useDeletedOrphans,
  useDeletedOrphansCount,
  useDeletedSessions,
  useRestoreSession,
} from '@/hooks/useSession.js'
import { kanbanAPI } from '@/services/kanban.js'
import { sessionAPI } from '@/services/session.js'
import { empty, errorBar, noticeBar, searchInput } from '@/views/_shared/recycleStyles.js'

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
const sourceBadge = css`
  flex-shrink: 0;
  padding: 1px 6px;
  font-size: 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-secondary);
`
const trashHint = css`
  color: var(--text-secondary);
  font-size: 11px;
  flex-shrink: 0;
`
/** 回收站保留期（与后端 purgeDeletedSessions 默认 60 天一致，仅展示用）。 */
const TRASH_RETENTION_DAYS = 60
/** 绝对上限（与后端 TRASH_ABSOLUTE_MAX_MS 一致）：从未查看的条目自删除起最长保留 365 天。 */
const TRASH_ABSOLUTE_MAX_DAYS = 365
/** A3：到期标记 → 物理清除的宽限期（与后端 TRASH_PURGE_GRACE_MS 一致，仅展示用）。 */
const TRASH_PURGE_GRACE_DAYS = 7

/** 剩余保留天数（负数视为 0：即将被后台清理）。 */
function daysLeft(baseline: number | null | undefined): number {
  if (!baseline) return TRASH_RETENTION_DAYS
  const ms = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000 - (Date.now() - baseline)
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)))
}

/** 剩余天数 + 绝对到期日（F6 修复：保留期自「首次打开回收站看到该分组」
 *  （metadata.trashSeenAt，分组粒度）起算，与后端 purgeDeletedSessions 一致；尚未看到的
 *  会话不显示倒计时（保留期自查看时起算），不会被静默提前清除。
 *  A3：purgePendingAt 存在 = 已到期进入宽限期——显示「即将清除」，恢复可保留。 */
function expiryLabel(s: Session): string {
  const pending = s.metadata.purgePendingAt
  if (pending) {
    const deadline = new Date(pending + TRASH_PURGE_GRACE_DAYS * 24 * 60 * 60 * 1000)
    const left = Math.max(0, Math.ceil((deadline.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    return `即将清除 · ${deadline.toLocaleDateString()} 前可恢复（剩 ${left} 天）`
  }
  const seen = s.metadata.trashSeenAt
  if (!seen) {
    // 未查看：保留期自首次打开回收站起算；但删除后仍有 365 天绝对上限兜底，
    // 给出绝对清除日避免「不打开就永不清理」的误读。
    const absCap = s.deletedAt
      ? new Date(s.deletedAt + TRASH_ABSOLUTE_MAX_DAYS * 24 * 60 * 60 * 1000)
      : null
    return absCap
      ? `待查看 · 首次打开后保留 ${TRASH_RETENTION_DAYS} 天（最长 ${absCap.toLocaleDateString()} 自动清除）`
      : `待查看 · 首次打开后保留 ${TRASH_RETENTION_DAYS} 天`
  }
  const expires = new Date(seen + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  return `剩 ${daysLeft(seen)} 天 · ${expires.toLocaleDateString()} 清除`
}

/** 看板回收站保留期自删除时刻起算（全局单一分组，无「首次查看」语义）；
 *  purgePendingAt 存在 = 已到期进入宽限期（7 天内可恢复，逾期物理清除）。 */
function kanbanExpiryLabel(b: { deletedAt: number; purgePendingAt: number | null }): string {
  if (b.purgePendingAt) {
    const deadline = b.purgePendingAt + TRASH_PURGE_GRACE_DAYS * 24 * 60 * 60 * 1000
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / (24 * 60 * 60 * 1000)))
    const when = new Date(deadline).toLocaleDateString()
    return `即将清除 · ${when} 前可恢复（剩 ${left} 天）`
  }
  const expires = new Date(b.deletedAt + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  return `${expires.toLocaleDateString()} 进入宽限`
}

/** 回收站列表：软删除会话 + 恢复/彻底删除按钮 + 清空回收站。
 *  父会话也在回收站的行做标记（恢复时连带还原祖先链）。
 *  P1-7：仅显示当前项目的删除会话；「清空」仅清空当前项目。 */
export function RecycleBin({ projectId }: { projectId: string }) {
  const { data: deleted, isLoading } = useDeletedSessions(projectId)
  // F1：孤儿（projectId=null）已删会话——删除项目所产生，任何项目回收站视图都不可见，
  // 需在本回收站内单独分组暴露，否则 60 天后被静默物理清除。
  // A3：折叠态只拉计数；展开时才拉列表并显式标记「已看到」（启动倒计时），
  // 打开任意项目回收站不再连带启动无关孤儿条目的保留期。
  const [orphansOpen, setOrphansOpen] = useState(false)
  const { data: orphanCountData } = useDeletedOrphansCount()
  const { data: orphans } = useDeletedOrphans(orphansOpen)
  const toggleOrphans = () => {
    const next = !orphansOpen
    setOrphansOpen(next)
    if (next) {
      sessionAPI.touchOrphansSeen().catch(() => {})
    }
  }
  const restore = useRestoreSession()
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  // P1 可达性：恢复结果反馈（重新归属项目 / 项目目录缺失的孤儿状态）
  const [notice, setNotice] = useState<string | null>(null)
  // P1-2：当前孤儿会话 id（目录失效且未随 restore 归属成功），提供「归属到当前项目」入口
  const [orphanId, setOrphanId] = useState<string | null>(null)

  // P2-5：未归属看板（项目删除软删除的看板，60 天保留期）——恢复/彻底删除入口。
  const { data: deletedBoardsData } = useQuery({
    queryKey: ['kanban', 'deleted'],
    queryFn: () => kanbanAPI.deletedBoards().then((d) => d.boards),
  })
  const deletedBoards = deletedBoardsData ?? []
  const restoreBoardMut = useMutation({
    mutationFn: (v: { boardId: string; projectId: string }) =>
      kanbanAPI.restoreDeletedBoard(v.boardId, v.projectId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kanban', 'deleted'] }),
  })
  const restoreBoardToOriginalMut = useMutation({
    mutationFn: (boardId: string) => kanbanAPI.restoreDeletedBoardToOriginal(boardId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kanban', 'deleted'] }),
  })
  const destroyBoardMut = useMutation({
    mutationFn: (boardId: string) => kanbanAPI.destroyDeletedBoard(boardId),
  })

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

  // P2-6：永久操作（彻底删除/清空回收站）分级确认弹层；软删除保留轻确认。
  // 状态必须声明在 early return 之前（hooks 规则：回收站空 → 非空的切换不得增减 hooks）。
  const [removeTarget, setRemoveTarget] = useState<Session | null>(null)
  const [showEmptyTrash, setShowEmptyTrash] = useState(false)

  if (isLoading) return <div className={empty}>加载中…</div>
  // P1-1：恢复/归属结果 notice 必须独立于「回收站为空」分支——
  // 恢复最后一个会话时回收站变空，若直接返回空态，notice（如 CLI 会话恢复提示）
  // 永远不会展示，用户只能看到列表消失。A3：孤儿分组同样独立于空态渲染。

  const deletedList = deleted ?? []
  const deletedIds = new Set(deletedList.map((s) => s.id))
  const hasDeletedParent = (s: Session): boolean =>
    s.parentId !== null && deletedIds.has(s.parentId)

  // 搜索态展示搜索结果（仍限制在回收站内）；默认展示完整列表。
  // M1：默认列表按紧迫度排序——宽限期内条目置顶，其次按「首次看到」起算的
  // 到期先后（先到期的在前），尚未看到的条目最后（保留期尚未起算）。
  const sortedDeleted = [...deletedList].sort((a, b) => {
    const pa = a.metadata.purgePendingAt
    const pb = b.metadata.purgePendingAt
    if (pa && !pb) return -1
    if (!pa && pb) return 1
    if (pa && pb) return pa - pb
    const sa = a.metadata.trashSeenAt
    const sb = b.metadata.trashSeenAt
    if (sa && sb) return sa - sb
    if (sa) return -1
    if (sb) return 1
    return (b.deletedAt ?? 0) - (a.deletedAt ?? 0)
  })
  const rows =
    searchDebounced.length > 1
      ? (searchResults?.results.map((r) => r.session) ?? [])
      : sortedDeleted

  // A3：已到期进入宽限期的条目计数（顶部警示，7 天内可恢复）。
  const pendingPurgeCount = deletedList.filter((s) => s.metadata.purgePendingAt).length

  // P2 子树恢复：统计会话在回收站内的派生后代（任意深度），恢复确认时提示。
  const byParent = new Map<string, Session[]>()
  for (const d of deletedList) {
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

  /** 回收站内已删除的祖先链（按父→祖顺序）。恢复会连带还原它们——
   *  事前在确认框中列出，比事后提示更符合「操作前知情」。 */
  const deletedAncestorsOf = (s: Session): Session[] => {
    const out: Session[] = []
    const byId = new Map(deletedList.map((d) => [d.id, d]))
    let pid = s.parentId
    const seen = new Set<string>()
    while (pid && !seen.has(pid)) {
      seen.add(pid)
      const p = byId.get(pid)
      if (!p) break
      out.push(p)
      pid = p.parentId
    }
    return out
  }

  const handleRemoveForever = (s: Session) => {
    setRemoveTarget(s)
  }

  const handleEmptyTrash = () => {
    setShowEmptyTrash(true)
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
      {pendingPurgeCount > 0 && (
        <div className={noticeBar} data-testid="purge-pending-notice">
          <span style={{ color: 'var(--warning)' }}>
            {pendingPurgeCount} 条已到期进入 {TRASH_PURGE_GRACE_DAYS}{' '}
            天宽限期：恢复可保留，逾期自动清除
          </span>
        </div>
      )}
      {deletedList.length === 0 && (
        <div className={empty} data-testid="trash-empty">
          回收站为空
        </div>
      )}
      {deletedList.length > 0 && (
        <>
          <div className={deletedRow}>
            <span className={trashHint}>
              自首次打开回收站看到该分组起保留 {TRASH_RETENTION_DAYS} 天（分组内条目同时起算），
              到期后宽限 {TRASH_PURGE_GRACE_DAYS} 天；从未查看的条目自删除起最长保留 365 天
            </span>
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
                  {expiryLabel(s)}
                </span>
                {s.source === 'cli' && (
                  <span
                    className={sourceBadge}
                    data-testid={`cli-source-${s.id}`}
                    title="CLI 会话（c0de chat）。恢复后与 Web 会话同树显示"
                  >
                    CLI
                  </span>
                )}
                <button
                  type="button"
                  className={restoreBtn}
                  onClick={() => {
                    // P2 子树恢复 + 事前祖先清单：恢复会连带还原派生会话与已删除的
                    // 父会话（保证会话树可达），确认框在操作前明示受影响对象。
                    const ancestors = deletedAncestorsOf(s)
                    if (descendants > 0 || ancestors.length > 0) {
                      const parts = [`恢复「${s.title}」？`]
                      if (descendants > 0) {
                        parts.push(`其 ${descendants} 个派生会话将一并恢复。`)
                      }
                      if (ancestors.length > 0) {
                        parts.push(
                          `为保持会话树完整，已删除的父会话将一并恢复：${ancestors
                            .map((a) => `「${a.title}」`)
                            .join('、')}。`,
                        )
                      }
                      if (!window.confirm(parts.join('\n'))) return
                    }
                    restore.mutate(
                      { id: s.id, projectId },
                      {
                        onError: (e: unknown) =>
                          setError(e instanceof Error ? e.message : String(e)),
                        onSuccess: (d) => {
                          setError(null)
                          const ancestorNote =
                            (d?.restoredAncestorCount ?? 0) > 0
                              ? `${d.crossedBatchAncestor ? '；同时连带还原了' : '；已连带还原'} ${d.restoredAncestorCount} 个父会话以保证会话树完整`
                              : ''
                          // A2：批次不同的已删后代滞留在回收站，显式提示单独恢复
                          const leftBehindNote =
                            (d?.leftBehindDescendantCount ?? 0) > 0
                              ? `；另有 ${d.leftBehindDescendantCount} 个分支未随本次恢复（删除批次不同），可在回收站单独恢复`
                              : ''
                          if (d?.orphaned) {
                            setNotice(
                              `「${s.title}」已恢复，但原项目目录已不存在，会话未归属任何项目${ancestorNote}${leftBehindNote}`,
                            )
                            setOrphanId(s.id)
                          } else if (d?.rebound) {
                            setNotice(
                              `「${s.title}」已恢复并重新归属到项目${ancestorNote}${leftBehindNote}`,
                            )
                            setOrphanId(null)
                          } else if (s.source === 'cli') {
                            // CLI 会话恢复后与 Web 会话同树显示（带 CLI 徽标）；
                            // 未绑定项目时在「CLI 会话（未绑定项目）」分组。
                            setNotice(
                              `「${s.title}」已恢复。CLI 会话与 Web 会话同树显示（未绑定项目时在列表底部分组）。${ancestorNote}${leftBehindNote}`,
                            )
                            setOrphanId(null)
                          } else {
                            setNotice((ancestorNote + leftBehindNote).slice(1) || null)
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
        </>
      )}
      {(orphanCountData?.count ?? 0) > 0 && (
        <>
          <div className={deletedRow} data-testid="orphan-trash-header">
            <button
              type="button"
              className={restoreBtn}
              onClick={toggleOrphans}
              aria-expanded={orphansOpen}
              data-testid="orphan-trash-toggle"
              title={orphansOpen ? '收起未归属项目的会话' : '展开未归属项目的会话'}
            >
              {orphansOpen ? '\u25BE' : '\u25B8'}
            </button>
            <span style={{ color: 'var(--warning)', fontSize: 12 }}>
              未归属项目（{orphanCountData?.count ?? 0}{' '}
              条，来自已删除的项目；恢复时可重建原项目或归属到当前项目）
            </span>
          </div>
          {orphansOpen &&
            (orphans ?? []).map((s) => (
              <div key={s.id} className={deletedRow} data-testid={`orphan-${s.id}`}>
                <span title={s.worktreePath ?? s.title}>{s.title}</span>
                <span title={s.deletedAt ? new Date(s.deletedAt).toLocaleString() : ''}>
                  {expiryLabel(s)}
                </span>
                <button
                  type="button"
                  className={restoreBtn}
                  onClick={() =>
                    restore.mutate(
                      { id: s.id, projectId, restoreMode: 'current-project' },
                      {
                        onError: (e: unknown) =>
                          setError(e instanceof Error ? e.message : String(e)),
                        onSuccess: (d) => {
                          setError(null)
                          setNotice(
                            d?.orphaned
                              ? `「${s.title}」已恢复，但原项目目录已不存在，未归属任何项目。`
                              : `「${s.title}」已恢复并归属到当前项目。`,
                          )
                          setOrphanId(d?.orphaned ? s.id : null)
                        },
                      },
                    )
                  }
                  data-testid={`restore-orphan-${s.id}`}
                  title="恢复并归属到当前项目（不重建原项目）"
                >
                  恢复到当前项目
                </button>
                <button
                  type="button"
                  className={restoreBtn}
                  onClick={() =>
                    restore.mutate(
                      { id: s.id },
                      {
                        onError: (e: unknown) =>
                          setError(e instanceof Error ? e.message : String(e)),
                        onSuccess: (d) => {
                          setError(null)
                          // P1-3：自动模式（原目录仍存在）重建项目时明示，
                          // 不再静默复活用户已删除的项目。
                          const recreated = d?.recreatedProject
                          if (recreated) {
                            setNotice(
                              `「${s.title}」已恢复，并重新创建了原项目「${recreated.name ?? '未命名项目'}」——该项目此前已删除，现在从回收站恢复而重建。`,
                            )
                            setOrphanId(null)
                          } else if (d?.orphaned) {
                            setNotice(
                              `「${s.title}」已恢复，但原项目目录已不存在，未归属任何项目。`,
                            )
                            setOrphanId(s.id)
                          } else {
                            setNotice(`「${s.title}」已恢复并归属到原项目。`)
                            setOrphanId(null)
                          }
                        },
                      },
                    )
                  }
                  data-testid={`restore-orphan-recreate-${s.id}`}
                  title="恢复并在原目录重建项目（若目录仍存在）"
                >
                  恢复并重建原项目
                </button>
                <button
                  type="button"
                  className={restoreBtn}
                  style={{ color: 'var(--error)' }}
                  onClick={() => handleRemoveForever(s)}
                  disabled={removeForever.isPending}
                  data-testid={`remove-orphan-${s.id}`}
                  title="彻底删除，不可恢复"
                >
                  彻底删除
                </button>
              </div>
            ))}
        </>
      )}
      {/* P2-5：未归属看板（删除项目软删除的看板，60 天保留期）——恢复需目标项目，
          当前视图即「当前项目」，故恢复入口=归属到当前项目。 */}
      {(deletedBoards?.length ?? 0) > 0 && (
        <>
          <div className={deletedRow} data-testid="orphan-kanban-header">
            <span style={{ color: 'var(--warning)', fontSize: 12 }}>
              未归属看板（{deletedBoards?.length ?? 0} 个，来自已删除的项目；删除后保留{' '}
              {TRASH_RETENTION_DAYS} 天，到期宽限 {TRASH_PURGE_GRACE_DAYS} 天再自动清除）
            </span>
          </div>
          {deletedBoards?.map((b) => (
            <div key={b.id} className={deletedRow} data-testid={`orphan-kanban-${b.id}`}>
              <span title={`看板来自「${b.projectName}」`}>
                📋 {b.projectName}（{b.cardCount} 张卡片）
              </span>
              <span title={new Date(b.deletedAt).toLocaleString()}>{kanbanExpiryLabel(b)}</span>
              <button
                type="button"
                className={restoreBtn}
                onClick={() =>
                  restoreBoardMut.mutate(
                    { boardId: b.id, projectId },
                    {
                      onSuccess: () => setNotice(`看板「${b.projectName}」已恢复到当前项目。`),
                      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
                    },
                  )
                }
                disabled={restoreBoardMut.isPending}
                data-testid={`restore-orphan-kanban-${b.id}`}
                title="恢复到当前项目（当前项目已有看板时会失败）"
              >
                恢复到当前项目
              </button>
              {b.deletedProjectWorktree && (
                <button
                  type="button"
                  className={restoreBtn}
                  onClick={() =>
                    restoreBoardToOriginalMut.mutate(b.id, {
                      onSuccess: (d) =>
                        setNotice(
                          d?.recreatedProject
                            ? `看板「${b.projectName}」已恢复，并重新创建了原项目「${d.recreatedProject.name ?? '未命名项目'}」。`
                            : `看板「${b.projectName}」已恢复到原项目。`,
                        ),
                      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
                    })
                  }
                  disabled={restoreBoardToOriginalMut.isPending}
                  data-testid={`restore-orphan-kanban-recreate-${b.id}`}
                  title="在原有目录重建项目并恢复看板（目录仍存在时生效）"
                >
                  恢复并重建原项目
                </button>
              )}
              <button
                type="button"
                className={restoreBtn}
                style={{ color: 'var(--error)' }}
                onClick={() => {
                  if (
                    window.confirm(
                      `彻底删除看板「${b.projectName}」（${b.cardCount} 张卡片）？此操作不可恢复。`,
                    )
                  ) {
                    destroyBoardMut.mutate(b.id, {
                      onSuccess: () => {
                        qc.invalidateQueries({ queryKey: ['kanban', 'deleted'] })
                        setNotice(`看板「${b.projectName}」已彻底删除。`)
                      },
                    })
                  }
                }}
                disabled={destroyBoardMut.isPending}
                data-testid={`remove-orphan-kanban-${b.id}`}
                title="彻底删除，不可恢复"
              >
                彻底删除
              </button>
            </div>
          ))}
        </>
      )}
      {removeTarget && (
        <DangerConfirmDialog
          open={true}
          title="彻底删除会话"
          description={`将彻底删除「${removeTarget.title}」及其 ${countDescendants(removeTarget.id)} 个派生会话。`}
          confirmWord={removeTarget.title}
          confirmLabel="彻底删除"
          onConfirm={() => {
            const id = removeTarget.id
            setRemoveTarget(null)
            removeForever.mutate(id)
          }}
          onClose={() => setRemoveTarget(null)}
        />
      )}
      {showEmptyTrash && (
        <DangerConfirmDialog
          open={true}
          title="清空回收站"
          description={`将永久删除本项目的全部 ${deletedList.length} 个回收站会话。`}
          confirmWord="清空"
          confirmLabel="清空回收站"
          onConfirm={() => {
            setShowEmptyTrash(false)
            emptyTrashMut.mutate()
          }}
          onClose={() => setShowEmptyTrash(false)}
        />
      )}
    </div>
  )
}
