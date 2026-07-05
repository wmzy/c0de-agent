import { css } from '@linaria/core'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { updateAPI } from '../services/update.js'

const banner = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  background: var(--primary);
  color: #fff;
  font-size: 13px;
  flex-shrink: 0;
`

const text = css`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const actions = css`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
`

const btn = css`
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 3px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
  min-height: auto;
  &:hover {
    background: rgba(255, 255, 255, 0.28);
  }
  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`

const linkBtn = css`
  background: transparent;
  color: #fff;
  border: none;
  padding: 3px 6px;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
  min-height: auto;
  opacity: 0.85;
  &:hover {
    opacity: 1;
  }
`

const POLL_INTERVAL = 5 * 60 * 1000 // 5 分钟轮询一次后台缓存

/**
 * 顶部更新提示横幅（spec §18.1 步骤 2：发现新版本 → 通知前端）。
 *
 * 数据源是后端 scheduler 缓存的版本检查结果，因此轮询本身不打外网。
 * 发现 hasUpdate 时展示横幅；用户可"立即应用"触发 POST /api/update/apply
 * （后端序列化快照 + npm 自更新 + spawn 新实例 + handoff 端口接管），
 * 或"稍后"临时关闭（dismissed 状态本地保存，下次有新版本号再提示）。
 *
 * 应用后预期旧实例 handoff 退出、新实例接管，前端 SSE 会重连。
 */
export function UpdateBanner() {
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
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

  // 无数据、无更新、或已 dismissed 当前版本 → 不渲染。
  if (!data?.hasUpdate) return null
  if (dismissedVersion === data.latestVersion) return null

  const applying = apply.isPending
  return (
    <div className={banner} data-testid="update-banner" role="status">
      <span className={text}>
        发现新版本 <strong>{data.latestVersion}</strong>（当前 {data.currentVersion}）
        {apply.isSuccess ? '· 已触发热更新，新实例即将接管…' : null}
        {apply.isError ? '· 热更新失败，请稍后重试或使用 c0de update --apply' : null}
      </span>
      <span className={actions}>
        {!apply.isSuccess && (
          <button
            type="button"
            className={btn}
            disabled={applying}
            onClick={() => apply.mutate()}
            data-testid="update-apply"
          >
            {applying ? '应用中…' : '立即应用'}
          </button>
        )}
        <button
          type="button"
          className={linkBtn}
          onClick={() => setDismissedVersion(data.latestVersion)}
          data-testid="update-dismiss"
        >
          稍后
        </button>
      </span>
    </div>
  )
}
