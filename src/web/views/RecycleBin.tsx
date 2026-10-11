import { css } from '@linaria/core'
import type { Session } from '@shared/types/message.js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { DangerConfirmDialog } from '@/components/DangerConfirmDialog.js'
import { SyncedInput } from '@/components/SyncedControls.js'
import {
  useDeletedOrphans,
  useDeletedOrphansCount,
  useDeletedSessions,
  useRestoreSession,
} from '@/hooks/useSession.js'
import { kanbanAPI } from '@/services/kanban.js'
import { sessionAPI } from '@/services/session.js'
import { empty, errorBar, noticeBar, searchInput } from '@/views/_shared/recycleStyles.js'
import { buildDeletedTreeIndex, countDeletedDescendants } from '@/views/_shared/recycleTree.js'

/** 失败原因取文案：APIError 现在是真正的 Error（message 即后端文案），
 *  但错误也可能来自非本层抛出的路径，结构化取 message 优先、instanceof 兜底。 */
function messageOf(e: unknown): string {
  return (e as { message?: string } | null)?.message ?? (e instanceof Error ? e.message : String(e))
}

const deletedRow = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--haze-color-text);
  border-bottom: 1px solid var(--haze-color-border);

  & > span:first-child {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  & > span:nth-child(2) {
    color: var(--haze-color-text-secondary);
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
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: var(--haze-color-bg);
  color: var(--haze-color-primary);
  cursor: pointer;
  &:hover {
    border-color: var(--haze-color-primary);
  }
`
const sourceBadge = css`
  flex-shrink: 0;
  padding: 1px 6px;
  font-size: 10px;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  color: var(--haze-color-text-secondary);
`
const trashHint = css`
  color: var(--haze-color-text-secondary);
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
  const {
    data: deleted,
    isLoading,
    isError,
    error: listError,
    refetch,
  } = useDeletedSessions(projectId)
  // F1：孤儿（projectId=null）已删会话——删除项目所产生，任何项目回收站视图都不可见，
  // 需在本回收站内单独分组暴露，否则 60 天后被静默物理清除。
  // A3：折叠态只拉计数；展开时才拉列表并显式标记「已看到」（启动倒计时），
  // 打开任意项目回收站不再连带启动无关孤儿条目的保留期。
  const [orphansOpen, setOrphansOpen] = useState(false)
  const {
    data: orphanCountData,
    isError: orphanCountError,
    error: orphanCountErrorObj,
    refetch: refetchOrphanCount,
  } = useDeletedOrphansCount()
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
  // 读失败必须与「确实没有」区分：此前只取 data，`?? []` 让整个分组（连同恢复/
  // 彻底删除按钮）静默消失，用户以为没有未归属看板，实际是「拉不到」，看板会按
  // 保留期被静默清除（与主列表 trash-load-error 同口径：给原因 + 重试）。
  const {
    data: deletedBoardsData,
    isError: deletedBoardsError,
    error: deletedBoardsErrorObj,
    refetch: refetchDeletedBoards,
  } = useQuery({
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
    // 破坏性操作失败必须留原因：此前这条链只有 onSuccess，失败时看板仍在列表、
    // 屏幕上零文字（同一页面的恢复/彻底删除会话都写了错误条），
    // 用户只能反复点确认框，或以为按钮坏了。
    onError: (e: unknown) => setError(`彻底删除看板失败：${messageOf(e)}`),
  })

  // P3：回收站搜索（此前删掉的会话只能逐行翻）——标题+消息内容，服务端搜索。
  const [search, setSearch] = useState('')
  const [searchDebounced, setSearchDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])
  // 阈值 1 而非 2：单字符查询此前被静默丢弃，而下方 rows 分支仍按
  // searchDebounced.length > 1 判断「是否在搜索」——两边同时为假时列出的是
  // 未过滤的全部分页条目，搜索框里有字却看不到任何收敛。服务端对单字符
  // 正常返回。
  // 三态齐全：查询只取 data 时，「还在查」与「查不了」都落进 rows 为空的分支，
  // 界面给出「回收站无匹配会话」——把「拉不到」说成「没有」，用户会据此认定
  // 删掉的会话已被清除。失败后（RQ 默认 retry: 2）这一句永久停在那里，且
  // 该区域内没有任何重试入口。
  const {
    data: searchResults,
    isLoading: searchLoading,
    isError: searchError,
    error: searchErrorObj,
    refetch: refetchSearch,
  } = useQuery({
    queryKey: ['sessions', 'search-deleted', projectId, searchDebounced],
    queryFn: () => sessionAPI.search(searchDebounced, projectId, true),
    enabled: searchDebounced.length >= 1,
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
    onError: (e: unknown) => setError(`归属到当前项目失败：${messageOf(e)}`),
  })

  const removeForever = useMutation({
    mutationFn: (id: string) => sessionAPI.removeForever(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions', 'deleted'] })
    },
    // 错误条前缀按操作给出：此前恢复/归属/彻底删除/清空四条链共用一个
    // 「恢复失败：」，清空回收站失败会被写成「恢复失败」——与 SessionList
    // 已修的「重命名失败写成删除失败」同类，用户照字面理解会被带偏。
    onError: (e: unknown) => setError(`彻底删除失败：${messageOf(e)}`),
  })

  const emptyTrashMut = useMutation({
    mutationFn: () => sessionAPI.emptyTrash(projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions', 'deleted'] })
      setNotice(null)
    },
    onError: (e: unknown) => setError(`清空回收站失败：${messageOf(e)}`),
  })

  // P2-6：永久操作（彻底删除/清空回收站）分级确认弹层；软删除保留轻确认。
  // 状态必须声明在 early return 之前（hooks 规则：回收站空 → 非空的切换不得增减 hooks）。
  const [removeTarget, setRemoveTarget] = useState<{
    session: Session
    descendants: number
  } | null>(null)
  const [showEmptyTrash, setShowEmptyTrash] = useState(false)

  if (isLoading) return <div className={empty}>加载中…</div>
  // 列表拉取失败必须与「真的为空」区分开：此前只判 isLoading，
  // 请求 500 时 deleted 为 undefined → deletedList 为空数组 → 落到
  // 「回收站为空」空态。用户看到的是「空的」，实际是「拉不到」，
  // 于是反复点刷新甚至以为会话被清空。实测注入 500 后等重试结束，
  // 页面稳定显示「回收站为空」、无任何错误提示。
  // 与 KanbanView 的「看板加载失败」保持同一套读失败表达，并给出重试入口。
  if (isError) {
    // APIError 现在是真正的 Error（services/api.ts 的 ApiErrorImpl），
    // `err.message` 即后端文案；但错误也可能来自非本层抛出的路径，
    // 结构化取 message 优先、instanceof 兜底，两种读法都不会退化。
    const message =
      (listError as { message?: string } | null)?.message ??
      (listError instanceof Error ? listError.message : null)
    return (
      <div>
        <div className={errorBar} data-testid="trash-load-error">
          回收站加载失败
          {message ? `：${message}` : '，请稍后重试。'}
        </div>
        <div className={empty}>
          <button
            type="button"
            className={restoreBtn}
            onClick={() => refetch()}
            data-testid="trash-retry"
          >
            重试
          </button>
        </div>
      </div>
    )
  }
  // P1-1：恢复/归属结果 notice 必须独立于「回收站为空」分支——
  // 恢复最后一个会话时回收站变空，若直接返回空态，notice（如 CLI 会话恢复提示）
  // 永远不会展示，用户只能看到列表消失。A3：孤儿分组同样独立于空态渲染。

  const deletedList = deleted ?? []
  // 与主列表同款的错误文案提取（APIError 现在是真正的 Error，取 message 优先、
  // instanceof 兜底，两种读法都不会退化）。
  const orphanCountErrText =
    (orphanCountErrorObj as { message?: string } | null)?.message ??
    (orphanCountErrorObj instanceof Error ? orphanCountErrorObj.message : null)
  const deletedBoardsErrText =
    (deletedBoardsErrorObj as { message?: string } | null)?.message ??
    (deletedBoardsErrorObj instanceof Error ? deletedBoardsErrorObj.message : null)
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
  // 「是否在搜索」与上面 query 的 enabled 必须是同一个口径：两边不一致时，
  // 搜索框有字却会列出未过滤的全部分页条目。
  const isSearching = searchDebounced.length >= 1
  const rows = isSearching ? (searchResults?.results.map((r) => r.session) ?? []) : sortedDeleted
  // 与文件列表失败态同口径取后端原因：APIError 现在是真正的 Error，
  // 但错误也可能来自非本层抛出的路径，结构化取 message 优先。
  const searchErrorMessage =
    (searchErrorObj as { message?: string } | null)?.message ??
    (searchErrorObj instanceof Error ? searchErrorObj.message : null)

  // A3：已到期进入宽限期的条目计数（顶部警示，7 天内可恢复）。
  const pendingPurgeCount = deletedList.filter((s) => s.metadata.purgePendingAt).length

  // P2 子树恢复：统计会话在回收站内的派生后代（任意深度），恢复确认时提示。
  // 计数走 _shared/recycleTree 的环守卫实现（parentId 成环数据此前会让内联的
  // 朴素栈遍历死循环——渲染期按行调用 → 页面冻结）；索引每渲染建一次，逐行只读。
  const deletedIndex = buildDeletedTreeIndex(deletedList)
  // 孤儿会话（projectId=null）不在 deletedList 里——它们只由 deleted?orphan=1
  // 单独列出。此前确认框一律用项目级 deletedIndex 算后代，孤儿条目必然得 0，
  // 于是在逐字确认框里明确写着「及其 0 个派生会话」，而服务端
  // permanentlyDeleteSession 走的是 deleteSessionSubtrees(handle, [id])：
  // 连同全部后代（含未软删的 fork 后代）一起物理清除，不可恢复。删除项目会
  // 把该项目全部会话（含 fork 子会话）软删成「未归属项目」分组，恰恰是后代
  // 最容易成树的地方，用户却据此以为只删一条。
  const orphanIndex = buildDeletedTreeIndex(orphans ?? [])
  /** 某条目的彻底删除影响面：按它所属的分组取索引，孤儿走 orphanIndex。 */
  const purgeDescendantsOf = (s: Session): number =>
    countDeletedDescendants(s.projectId ? deletedIndex : orphanIndex, s.id)
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
    // 影响面在点开确认的那一刻定格：孤儿分组折叠后 orphans 变 undefined，
    // 数字若跟着活数据走，会在逐字确认途中悄悄从「及其 2 个派生会话」退回 0。
    setRemoveTarget({ session: s, descendants: purgeDescendantsOf(s) })
  }

  const handleEmptyTrash = () => {
    setShowEmptyTrash(true)
  }

  return (
    <div>
      {error && (
        <div className={errorBar} role="alert" data-testid="restore-error">
          {error}
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
          <span style={{ color: 'var(--haze-color-warning)' }}>
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
          <SyncedInput
            className={searchInput}
            type="search"
            placeholder="搜索回收站标题或消息内容…"
            /* 显式名称而非只靠 placeholder：placeholder 只是视觉提示（HTML-AAM 会在名称
             * 为空时拿它兜底，但那是脆弱的名字来源），读屏/语音控制依赖稳定字段名。 */
            aria-label="搜索回收站标题或消息内容"
            value={search}
            onChange={(v) => setSearch(v)}
            data-testid="trash-search"
          />
          {searchError && isSearching ? (
            <div className={errorBar} role="alert" data-testid="trash-search-error">
              回收站搜索失败
              {searchErrorMessage ? `：${searchErrorMessage}` : '，请稍后重试。'}{' '}
              <button
                type="button"
                className={restoreBtn}
                onClick={() => void refetchSearch()}
                data-testid="trash-search-retry"
              >
                重试
              </button>
            </div>
          ) : null}
          {rows.length === 0 && isSearching && !searchError ? (
            <div className={empty}>{searchLoading ? '搜索中…' : '回收站无匹配会话'}</div>
          ) : null}
          {rows.map((s) => {
            const descendants = countDeletedDescendants(deletedIndex, s.id)
            return (
              <div key={s.id} className={deletedRow}>
                <span title={s.title}>{s.title}</span>
                {hasDeletedParent(s) && (
                  <span
                    style={{ color: 'var(--haze-color-warning)', fontSize: 11, flexShrink: 0 }}
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
                        onError: (e: unknown) => setError(`恢复失败：${messageOf(e)}`),
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
                  style={{ color: 'var(--haze-color-danger)' }}
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
      {/* F1：孤儿（未归属项目）会话只有本分组能看见与恢复——计数读取失败时此前用
          `?? 0` 把整组连同恢复入口一起吃掉，页面零文字，用户看到的是一个「没有
          孤儿」的回收站，而这些会话会按保留期被静默清除。读不到必须说出来 + 重试。 */}
      {orphanCountError && (
        <div className={errorBar} role="alert" data-testid="orphan-count-error">
          未归属项目会话读取失败
          {orphanCountErrText ? `：${orphanCountErrText}` : '，请稍后重试。'}{' '}
          <button
            type="button"
            className={restoreBtn}
            onClick={() => void refetchOrphanCount()}
            data-testid="orphan-count-retry"
          >
            重试
          </button>
        </div>
      )}
      {/* P2-5：未归属看板读取失败同口径——此前 `?? []` 让整组（连同合并/重建原项目/
          彻底删除）静默消失，用户只会以为没有未归属看板。 */}
      {deletedBoardsError && (
        <div className={errorBar} role="alert" data-testid="orphan-kanban-error">
          未归属看板读取失败
          {deletedBoardsErrText ? `：${deletedBoardsErrText}` : '，请稍后重试。'}{' '}
          <button
            type="button"
            className={restoreBtn}
            onClick={() => void refetchDeletedBoards()}
            data-testid="orphan-kanban-retry"
          >
            重试
          </button>
        </div>
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
            <span style={{ color: 'var(--haze-color-warning)', fontSize: 12 }}>
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
                        onError: (e: unknown) => setError(`恢复失败：${messageOf(e)}`),
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
                        onError: (e: unknown) => setError(`恢复失败：${messageOf(e)}`),
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
                  style={{ color: 'var(--haze-color-danger)' }}
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
            <span style={{ color: 'var(--haze-color-warning)', fontSize: 12 }}>
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
                      onSuccess: () => setNotice(`看板「${b.projectName}」已合并到当前项目看板。`),
                      onError: (e) => setError(`恢复看板失败：${messageOf(e)}`),
                    },
                  )
                }
                disabled={restoreBoardMut.isPending}
                data-testid={`restore-orphan-kanban-${b.id}`}
                title="合并到当前项目看板（缺失列与卡片并入现有看板；当前项目无看板时等价恢复）"
              >
                合并到当前项目
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
                      onError: (e) => setError(`恢复看板失败：${messageOf(e)}`),
                    })
                  }
                  disabled={restoreBoardToOriginalMut.isPending}
                  data-testid={`restore-orphan-kanban-recreate-${b.id}`}
                  title="在原有目录重建项目并合并恢复看板（目录仍存在时生效；原目录已有看板时合并）"
                >
                  恢复并重建原项目
                </button>
              )}
              <button
                type="button"
                className={restoreBtn}
                style={{ color: 'var(--haze-color-danger)' }}
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
          description={`将彻底删除「${removeTarget.session.title}」及其 ${removeTarget.descendants} 个派生会话。`}
          confirmWord={removeTarget.session.title}
          confirmLabel="彻底删除"
          onConfirm={() => {
            const id = removeTarget.session.id
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
