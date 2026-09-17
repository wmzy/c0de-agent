import { css } from '@linaria/core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import { BranchTree } from '@/components/BranchTree.js'
import { Dialog } from '@/components/Dialog.js'
import { useDeleteSession, useProjects, useSessionTree } from '@/hooks/useSession.js'
import { sessionAPI } from '@/services/session.js'
import type { Project, SessionTreeNode } from '@/types/index.js'
import { empty, errorBar, noticeBar, searchInput } from '@/views/_shared/recycleStyles.js'
import { RecycleBin } from '@/views/RecycleBin.js'

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

/* P2-5：会话树底部 CLI 会话可见性说明（CLI/Web 同库不同视图的心智提示）。 */
const cliHint = css`
  margin-top: auto;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 11px;
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

/* P1-1：回收站行来源标记（CLI 会话恢复后不出现在 Web 会话树）。 */

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

  // P1-2：未绑定项目的持久化 CLI 会话（cwd 不属于任何已注册项目时产生）。
  // 项目树按 projectId 过滤会漏掉它们——单独分组展示，保证 CLI 会话在 Web 可达。
  const unboundCliRoots = useMemo(
    () =>
      search.length === 0
        ? (tree ?? []).filter((n) => n.session.projectId == null && n.session.source === 'cli')
        : [],
    [tree, search],
  )

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
    if (!window.confirm(`删除该会话及其全部消息？${branchNote}将移入回收站，60 天内可恢复。`))
      return
    del.mutate(id, {
      onSuccess: () => onDeleted?.(id),
      onError: (e: unknown) => {
        setDeleteError(e instanceof Error ? e.message : String(e))
      },
    })
  }

  /** P1-2：导入目标选择（导出文件原项目在本机存在且非当前项目时弹窗选择）。 */
  const [importChoice, setImportChoice] = useState<{
    data: unknown
    original: Project
    importPermissions: boolean
  } | null>(null)
  const { data: projects } = useProjects()

  /** 执行导入：绑定目标项目后刷新树并跳转；notice 明示工具执行目录。 */
  const doImport = async (data: unknown, targetId: string, importPermissions: boolean) => {
    setImporting(true)
    try {
      const result = await sessionAPI.importSession(data, targetId, { importPermissions })
      await qc.invalidateQueries({ queryKey: ['sessions'] })
      await qc.invalidateQueries({ queryKey: ['sessions', 'tree'] })
      const target = projects?.find((p) => p.id === targetId)
      const notes: string[] = []
      if (result.flattened)
        notes.push('注意：该会话原属分支树，导入后层级关系已丢失，将作为独立根会话导入。')
      // P1-2：明示工具执行目录，防用户在错误项目继续对话误改文件。
      notes.push(`该会话的工具将在 ${target?.worktree ?? '目标项目的目录'} 执行。`)
      // P0：权限态剥离时明确告知（此前静默迁移 auto/alwaysAllow 有安全隐患）。
      if (!result.permissionsMigrated) notes.push('权限态（自动授权/始终允许）未随迁。')
      setImportNotice(`已导入到项目「${target?.name ?? '未命名项目'}」：${notes.join(' ')}`)
      onSelect(result.sessionId)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }

  /** 检测导出文件的权限态（permissionMode=auto 或 alwaysAllow 非空）。 */
  const detectExportPermissions = (data: unknown): { auto: boolean; allowCount: number } => {
    const meta = (data as { session?: { metadata?: Record<string, unknown> } } | null)?.session
      ?.metadata
    const alwaysAllow = Array.isArray(meta?.alwaysAllow) ? meta.alwaysAllow : []
    return { auto: meta?.permissionMode === 'auto', allowCount: alwaysAllow.length }
  }

  /** 导入会话导出 JSON：解析后匹配原项目归属，冲突时弹目标选择。
   *  flattened 提示（P2）：原会话的分支树结构被扁平化为独立根会话。 */
  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复选择同一文件
    if (!file) return
    setImportError(null)
    setImportNotice(null)
    try {
      const data = JSON.parse(await file.text()) as {
        session?: { projectId?: unknown; worktreePath?: unknown } | null
      } | null
      // P1-2：导出文件带原项目归属；原项目在本机存在且非当前项目时让用户
      // 选择导入目标，避免会话绑定到错误项目后工具在错误目录执行。
      const exportedProjectId =
        typeof data?.session?.projectId === 'string' ? data.session.projectId : ''
      const exportedWorktree =
        typeof data?.session?.worktreePath === 'string' && data.session.worktreePath
          ? data.session.worktreePath
          : ''
      const original = (projects ?? []).find(
        (p) =>
          (exportedProjectId && p.id === exportedProjectId) ||
          (exportedWorktree && p.worktree === exportedWorktree),
      )
      // P0：权限态迁移需用户显式确认（默认剥离）。导出文件含 auto 模式或
      // alwaysAllow 白名单时，导入前明示风险并让用户选择。
      const perms = detectExportPermissions(data)
      let importPermissions = false
      if (perms.auto || perms.allowCount > 0) {
        const detail = [
          perms.auto ? '自动授权模式（auto）' : null,
          perms.allowCount > 0 ? `始终允许工具白名单（${perms.allowCount} 个）` : null,
        ]
          .filter(Boolean)
          .join('、')
        importPermissions = window.confirm(
          `该会话导出包含权限状态：${detail}。\n` +
            `迁移后这些授权将在导入的会话中立即生效（工具免确认执行）。\n` +
            `点「确定」随迁权限状态；点「取消」仅导入消息，权限使用默认设置（推荐）。`,
        )
      }
      if (original && original.id !== projectId) {
        setImportChoice({ data, original, importPermissions })
        return
      }
      await doImport(data, projectId, importPermissions)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
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
            <div className={empty}>{search ? '无匹配会话' : '该项目下暂无会话'}</div>
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
          {unboundCliRoots.length > 0 && (
            <div className={matchSection} data-testid="unbound-cli-section">
              <div className={matchHeader}>CLI 会话（未绑定项目）</div>
              <BranchTree
                nodes={unboundCliRoots}
                activeId={activeId}
                onSelect={onSelect}
                onDelete={handleDelete}
                onRename={handleRename}
              />
            </div>
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
          {!isLoading && (
            <div className={cliHint} data-testid="cli-session-hint">
              已续接的 CLI 会话（c0de chat --continue）与 Web 会话同树显示；一次性 CLI 问答 30
              天后自动清理，不在此显示。`c0de sessions list` 可查看全部会话。
            </div>
          )}
        </>
      ) : (
        <RecycleBin projectId={projectId} />
      )}
      {importChoice && (
        <Dialog
          testId="import-target-dialog"
          onClose={() => setImportChoice(null)}
          title="选择导入目标"
          footer={
            <>
              <button type="button" className={addBtn} onClick={() => setImportChoice(null)}>
                取消
              </button>
              <button
                type="button"
                className={addBtn}
                onClick={() => {
                  const choice = importChoice
                  setImportChoice(null)
                  void doImport(choice.data, projectId, choice.importPermissions)
                }}
              >
                导入到当前项目
              </button>
              <button
                type="button"
                className={addBtn}
                data-testid="import-to-original"
                onClick={() => {
                  const choice = importChoice
                  setImportChoice(null)
                  void doImport(choice.data, choice.original.id, choice.importPermissions)
                }}
              >
                恢复到原项目「{importChoice.original.name ?? '未命名项目'}」
              </button>
            </>
          }
        >
          该会话导出自项目「{importChoice.original.name ?? '未命名项目'}」（
          {importChoice.original.worktree}
          ）。导入到哪个项目？继续对话时工具将在目标项目的工作目录中执行。
        </Dialog>
      )}
    </div>
  )
}
