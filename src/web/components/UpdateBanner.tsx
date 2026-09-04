import { css } from '@linaria/core'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { updateAPI } from '../services/update.js'

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

/** 「稍后」dismissal 记录：值为版本号，存 sessionStorage（本次标签页会话内不再展示）。 */
const DISMISS_KEY = 'c0de-agent:updateDismissed'

function loadDismissed(): string | null {
  try {
    return sessionStorage.getItem(DISMISS_KEY)
  } catch {
    return null
  }
}

function saveDismissed(version: string): void {
  try {
    sessionStorage.setItem(DISMISS_KEY, version)
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
 * 或"稍后"关闭——dismissed 版本号记入 sessionStorage，本次标签页会话内
 * （含路由切换/刷新）不再展示，出现新版本号时重新提示。
 *
 * 应用后预期旧实例 handoff 退出、新实例接管，前端 SSE 会重连。
 */
export function UpdateBanner() {
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(loadDismissed)
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

  // P0-2：无法自动安装（未知安装方式/等待手动安装超时）→ 显示手动更新指引
  const manual = apply.isError
    ? (() => {
        const err = apply.error as unknown as { code?: string; details?: { command?: string } }
        return err?.code === 'MANUAL_UPDATE_REQUIRED'
          ? { command: err.details?.command ?? 'npm install -g c0de-agent' }
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
        {apply.isSuccess ? '· 已触发热更新，新实例即将接管…' : null}
        {manual ? '· 无法自动更新，请手动执行以下命令' : null}
        {apply.isError && !manual ? '· 热更新失败，请稍后重试或使用 c0de update --apply' : null}
      </span>
      {manual && (
        <span className={text} data-testid="manual-update-hint" style={{ color: 'var(--warning)' }}>
          <code>{manual.command}</code>（完成后服务将自动滚动切换）
        </span>
      )}
      <span className={actions}>
        {!apply.isSuccess && !manual && (
          <button
            type="button"
            className={btn}
            disabled={applying}
            onClick={() => {
              // P1-1：热更新会暂停/中止进行中的任务并关闭所有终端面板，apply 前必须让用户知情。
              if (
                !window.confirm(
                  '热更新将暂停进行中的对话任务（可能中止未达安全点的任务）并关闭所有终端面板，确认继续？',
                )
              ) {
                return
              }
              apply.mutate()
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
    </div>
  )
}
