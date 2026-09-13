import { css } from '@linaria/core'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { updateAPI } from '../services/update.js'
import { DangerConfirmDialog } from './DangerConfirmDialog.js'

const impactList = css`
  margin-top: 8px;
  font-size: 12px;
  & ul {
    margin: 4px 0 8px;
    padding-left: 18px;
    & li {
      margin: 2px 0;
    }
  }
`

const impactHead = css`
  font-weight: 600;
  color: var(--text);
`

const impactMeta = css`
  color: var(--text-secondary);
  font-size: 11px;
`

const rerunOption = css`
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-secondary);
  & input {
    vertical-align: middle;
    margin-right: 4px;
  }
  & code {
    font-size: 11px;
    color: var(--text);
  }
`

// 紧凑单行窄条（高 28px ≤ 32px）：中性 --bg-secondary 底 + 1px 底边框 + 小圆点强调，
// 取代全宽高饱和蓝，降低视觉压制；文字 --text 对 --bg-secondary 明暗主题均 ≥ 12:1（AA）。
const banner = css`
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 12px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font-size: 12px;
  flex-shrink: 0;
`

// 6px 版本提示圆点：整条横幅唯一的彩色强调，纯装饰不承担文字对比度
const dot = css`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary);
  flex-shrink: 0;
`

const text = css`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1;
`

const actions = css`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
`

// 反色中性实心按钮：底 --text / 字 --bg，明暗主题对比度均 ≥ 16:1（AA），
// 取代旧「白字压 rgba(255,255,255,.18)」的约 3.8:1。
const btn = css`
  background: var(--text);
  color: var(--bg);
  border: none;
  border-radius: 3px;
  padding: 3px 10px;
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
  min-height: auto;
  min-width: auto;
  &:hover {
    opacity: 0.85;
  }
  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`

// 次级文字按钮「稍后」：--text-secondary 对 --bg-secondary 为 5.3:1（亮）/ 5.6:1（暗），≥ AA
const linkBtn = css`
  background: transparent;
  color: var(--text-secondary);
  border: none;
  padding: 3px 6px;
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
  text-decoration: underline;
  min-height: auto;
  min-width: auto;
  &:hover {
    color: var(--text);
  }
`

const POLL_INTERVAL = 5 * 60 * 1000 // 5 分钟轮询一次后台缓存

/** 「稍后」dismissal 记录：值为版本号，存 localStorage（该版本号跨会话不再提示，
 *  出现新版本时重新展示）。P2-8：原 sessionStorage 每次重开标签页都再弹，低频用户被同一版本持续打扰。 */
const DISMISS_KEY = 'c0de-agent:updateDismissed'

function loadDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY)
  } catch {
    return null
  }
}

function saveDismissed(version: string): void {
  try {
    localStorage.setItem(DISMISS_KEY, version)
  } catch {
    // 存储不可用（隐私模式等）时静默降级：仅本次组件实例内生效
  }
}

/**
 * 顶部更新提示横幅（spec §18.1 步骤 2：发现新版本 → 通知前端）。
 *
 * 紧凑形态：28px 单行窄条，中性底色 + 小圆点强调，不再占用大面积高饱和蓝。
 *
 * 数据源是后端 scheduler 缓存的版本检查结果，因此轮询本身不打外网。
 * 发现 hasUpdate 时展示横幅；用户可"立即应用"触发 POST /api/update/apply
 * （后端序列化快照 + npm 自更新 + spawn 新实例 + handoff 端口接管），
 * 或"稍后"关闭——dismissed 版本号记入 localStorage，该版本跨标签页会话
 * 不再展示，出现新版本号时重新提示。
 *
 * 应用后预期旧实例 handoff 退出、新实例接管端口。进行中的 SSE 流会中断
 * （会话显示 interrupted，可重发上一条消息继续）；后续请求自动落到新实例。
 * B1：页面仍在运行旧版前端 JS——apply 成功后横幅提示「刷新页面」完成界面切换，
 * 避免旧前端 + 新后端的混版本行为异常。
 */
export function UpdateBanner() {
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(loadDismissed)
  // P1-1/P3：热更新影响面分级确认弹层（替代 window.confirm）——
  // 列出将被中断的对话与将被关闭的终端（含标题），输入版本号确认。
  const [confirmOpen, setConfirmOpen] = useState(false)
  // P3-7：用户勾选「更新后自动重启」的终端 id（仅对检测到前台命令的终端展示）。
  const [rerunIds, setRerunIds] = useState<Set<string>>(new Set())
  const { data } = useQuery({
    queryKey: ['update-status'],
    queryFn: updateAPI.status,
    refetchInterval: POLL_INTERVAL,
    // 错误静默：版本检查失败不影响主界面。
    retry: false,
  })

  const apply = useMutation({
    mutationFn: updateAPI.apply,
  })

  // P0-2：无法自动安装（未知安装方式）或安装失败 → 显示手动更新指引。
  // 新流程：install 失败发生在 pause 之前，服务端不等待、不会自动滚动切换；
  // 用户手动安装后需自行重启 c0de serve（数据持久化，会话无需快照即可恢复）。
  const applyErr = apply.error as unknown as { code?: string; details?: { command?: string } }
  const errCode = applyErr?.code
  // P2-8：dev 模式无 handoff server——区分「不支持」与「失败」，给出正确指引而非
  // 「请稍后重试或使用 c0de update --apply」这种对 dev 用户无解的建议。
  const devUnavailable = errCode === 'HOT_UPDATE_UNAVAILABLE'
  const manual = apply.isError
    ? (() => {
        const command = applyErr?.details?.command ?? 'npm install -g c0de-agent'
        return errCode === 'MANUAL_UPDATE_REQUIRED' || errCode === 'INSTALL_FAILED'
          ? { command }
          : null
      })()
    : null

  // 无数据、无更新、或已 dismissed 当前版本 → 不渲染。
  if (!data?.hasUpdate) return null
  if (dismissedVersion === data.latestVersion) return null

  const applying = apply.isPending
  const dismiss = () => {
    setDismissedVersion(data.latestVersion)
    saveDismissed(data.latestVersion)
  }
  return (
    <div className={banner} data-testid="update-banner" role="status">
      <span className={dot} aria-hidden="true" />
      <span className={text}>
        发现新版本 <strong>{data.latestVersion}</strong>（当前 {data.currentVersion}）
        {apply.isSuccess ? '· 新版本已就绪：后续请求已落到新实例，请刷新页面完成界面切换' : null}
        {manual ? '· 无法自动更新，请手动执行以下命令' : null}
        {devUnavailable ? '· 开发模式（vite dev）不支持热更新，请使用独立 c0de serve' : null}
        {apply.isError && !manual && !devUnavailable
          ? '· 热更新失败，请稍后重试或使用 c0de update --apply'
          : null}
      </span>
      {manual && (
        <span className={text} data-testid="manual-update-hint" style={{ color: 'var(--warning)' }}>
          <code>{manual.command}</code>（完成后请重启 c0de serve 生效）
        </span>
      )}
      <span className={actions}>
        {apply.isSuccess && (
          // B1：页面仍在运行旧版前端 JS——刷新才加载新版本界面，
          // 避免「更新成功但界面行为异常」的混版本困惑。
          <button
            type="button"
            className={btn}
            onClick={() => window.location.reload()}
            data-testid="update-reload"
          >
            刷新页面
          </button>
        )}
        {!apply.isSuccess && !manual && !devUnavailable && (
          <button
            type="button"
            className={btn}
            disabled={applying}
            onClick={() => {
              setRerunIds(new Set())
              setConfirmOpen(true)
            }}
            data-testid="update-apply"
          >
            {applying ? '应用中…' : '立即应用'}
          </button>
        )}
        <button type="button" className={linkBtn} onClick={dismiss} data-testid="update-dismiss">
          稍后
        </button>
      </span>
      <DangerConfirmDialog
        open={confirmOpen}
        title="应用更新"
        confirmWord={data.latestVersion}
        confirmLabel="立即应用"
        busy={applying}
        onConfirm={() => {
          setConfirmOpen(false)
          apply.mutate([...rerunIds])
        }}
        onClose={() => setConfirmOpen(false)}
        description={
          <div>
            将更新到版本 <strong>{data.latestVersion}</strong>。热更新会暂停进行中的对话任务
            （未达安全点的任务可能被中止），并关闭所有终端面板——终端里正在运行的进程 （如 dev
            server）会停止；更新完成后将在原位重建 shell，可在刷新页面后继续使用。
            <ImpactList
              runs={data?.impact?.runs ?? []}
              terminals={data?.impact?.terminals ?? []}
              pendingPermissionCount={data?.impact?.pendingPermissionCount ?? 0}
              rerunIds={rerunIds}
              onToggleRerun={(id) =>
                setRerunIds((prev) => {
                  const next = new Set(prev)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
            />
          </div>
        }
      />
    </div>
  )
}

/** 影响面清单：逐项列出将被中断的对话与将被关闭的终端（P1：含标题，可判断是否重要）。
 *  P3-9：待确认的权限请求会在更新后静默失效（隐含按拒绝处理），一并明示。 */
function ImpactList({
  runs,
  terminals,
  pendingPermissionCount,
  rerunIds,
  onToggleRerun,
}: {
  runs: Array<{ sessionId: string; title: string; agentType?: string }>
  terminals: Array<{ id: string; title: string; shell: string; cwd: string; command?: string }>
  pendingPermissionCount: number
  rerunIds: Set<string>
  onToggleRerun: (id: string) => void
}) {
  const hasAny = runs.length > 0 || terminals.length > 0 || pendingPermissionCount > 0
  if (!hasAny) return null
  return (
    <div className={impactList}>
      {runs.length > 0 && (
        <>
          <div className={impactHead}>将中断 {runs.length} 个进行中的对话：</div>
          <ul>
            {runs.map((r) => (
              <li key={r.sessionId}>
                {r.title}
                {r.agentType ? `（${r.agentType}）` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      {pendingPermissionCount > 0 && (
        <div className={impactHead}>
          有 {pendingPermissionCount} 个等待确认的权限请求：更新后弹窗将失效（该工具按拒绝处理），
          请先处理或更新后在时间线中重发。
        </div>
      )}
      {terminals.length > 0 && (
        <>
          <div className={impactHead}>将关闭 {terminals.length} 个终端面板：</div>
          <ul>
            {terminals.map((t) => (
              <li key={t.id}>
                {t.title}{' '}
                <span className={impactMeta}>
                  ({t.shell} · {t.cwd})
                </span>
                {t.command && (
                  <label className={rerunOption}>
                    <input
                      type="checkbox"
                      checked={rerunIds.has(t.id)}
                      onChange={() => onToggleRerun(t.id)}
                      data-testid={`rerun-${t.id}`}
                    />{' '}
                    更新后自动重启 <code>{t.command}</code>
                  </label>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
