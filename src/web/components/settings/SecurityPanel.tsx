import type { Config } from '@shared/types/config.js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { authAPI } from '../../services/auth.js'
import { CommaListInput } from './CommaListInput.js'
import { checkRow, field, fieldInput, hint, section, sectionTitle } from './styles.js'

interface SecurityPanelProps {
  security: Config['security']
  permission: Config['permission']
  onSecurityChange: (patch: Partial<Config['security']>) => void
  onPermissionChange: (patch: Partial<Config['permission']>) => void
}

/** 已授权设备管理（P2-16 配套）：列出/撤销设备。撤销唯一设备将退出本页面（token 失效）。 */
function DevicesSection() {
  const qc = useQueryClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['auth', 'devices'],
    queryFn: () => authAPI.listDevices(),
    staleTime: 30_000,
    retry: false,
  })
  const revoke = useMutation({
    mutationFn: (id: string) => authAPI.revokeDevice(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auth', 'devices'] }),
  })
  const devices = data?.devices ?? []

  if (isLoading) return <p className={hint}>加载已授权设备…</p>
  if (isError) return <p className={hint}>获取已授权设备失败（认证可能未启用）</p>
  if (devices.length === 0) return <p className={hint}>暂无已授权设备</p>

  return (
    <div data-testid="device-list">
      {devices.map((d) => (
        <div
          key={d.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            marginBottom: 6,
          }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {d.name} <span style={{ opacity: 0.6, fontSize: 11 }}>{d.id.slice(0, 8)}…</span>
          </span>
          <span style={{ opacity: 0.6, fontSize: 11 }}>
            {new Date(d.createdAt).toLocaleDateString()}
          </span>
          <button
            type="button"
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '2px 8px',
              fontSize: 12,
              cursor: 'pointer',
              color: 'var(--error)',
              background: 'var(--bg)',
              minHeight: 'auto',
              minWidth: 'auto',
            }}
            disabled={revoke.isPending}
            onClick={() => {
              // 撤销立即生效（服务端热加载）；撤销后本页 token 可能立即失效
              if (
                !window.confirm(
                  `撤销设备「${d.name}」？该设备将立即失去访问权限。` +
                    '若撤销的是唯一设备，请用 c0de auth reset 重新注册首设备。',
                )
              ) {
                return
              }
              revoke.mutate(d.id)
            }}
          >
            撤销
          </button>
        </div>
      ))}
    </div>
  )
}

/** 安全与权限配置：Bearer Token 认证、CORS 来源、已授权设备、以及启动时的默认授权模式。 */
function SecurityPanel({
  security,
  permission,
  onSecurityChange,
  onPermissionChange,
}: SecurityPanelProps) {
  return (
    <>
      <div className={section}>
        <h2 className={sectionTitle}>安全</h2>
        <label className={checkRow}>
          <input
            type="checkbox"
            checked={security.authEnabled}
            onChange={(e) => {
              const next = e.target.checked
              if (next) {
                onSecurityChange({ authEnabled: true })
                return
              }
              // 关闭认证是高风险操作（服务绑 0.0.0.0，所有 API 将无鉴权），fail-closed 确认。
              if (
                !window.confirm(
                  '关闭认证将移除所有 API 鉴权，任何能访问该服务端口的进程/设备都能执行任意工具。确定关闭？',
                )
              ) {
                return
              }
              onSecurityChange({ authEnabled: false })
            }}
          />
          <span>启用 Bearer Token 认证</span>
        </label>
        {security.authEnabled && (
          <>
            <label className={field}>
              <span>Token</span>
              <input
                className={fieldInput}
                type="password"
                value={security.token ?? ''}
                onChange={(e) => onSecurityChange({ token: e.target.value })}
                placeholder="Bearer Token"
              />
            </label>
            {security.token && (
              <div className={hint}>
                注意：静态 token 以明文存储在 config.json（chmod 600）。适用 CI/脚本场景；
                交互使用建议留空，走设备配对机制。
              </div>
            )}
            <div className={field}>
              <span>已授权设备</span>
              <DevicesSection />
            </div>
          </>
        )}
        <label className={field} htmlFor="cfg-allowed-origins">
          <span>允许的 CORS 来源</span>
          <CommaListInput
            id="cfg-allowed-origins"
            className={fieldInput}
            value={security.allowedOrigins}
            onCommit={(items) => onSecurityChange({ allowedOrigins: items })}
            placeholder="（本地回环始终允许）"
          />
        </label>
      </div>
      <div className={section}>
        <h2 className={sectionTitle}>自动授权</h2>
        <label className={field}>
          <span>默认模式</span>
          <select
            aria-label="默认授权模式"
            value={permission?.defaultMode ?? 'default'}
            onChange={(e) =>
              onPermissionChange({
                defaultMode: e.target.value as Config['permission']['defaultMode'],
              })
            }
          >
            <option value="default">逐个确认（推荐）</option>
            <option value="auto">自动授权（YOLO，跳过确认）</option>
          </select>
        </label>
        <p className={hint}>
          启动时的默认授权模式。「自动授权」会跳过所有 ask 工具（含 bash）的确认。Chat
          页底部的「自动授权」开关与本项联动：会话页为会话级覆盖
          （持久化到会话）；草稿页（无会话）修改全局默认并持久化到此处。
        </p>
        <label className={field}>
          <span>确认超时后的动作</span>
          <select
            aria-label="确认超时后的动作"
            value={permission?.timeoutAction ?? 'pause'}
            onChange={(e) =>
              onPermissionChange({
                timeoutAction: e.target.value as NonNullable<Config['permission']['timeoutAction']>,
              })
            }
          >
            <option value="pause">拒绝并暂停对话（推荐）</option>
            <option value="deny">拒绝并继续执行</option>
          </select>
        </label>
        <p className={hint}>
          工具等待确认超时后仅提示；宽限期满仍未处理则自动拒绝。
          「拒绝并暂停」会在拒绝后暂停对话，等你点击「恢复」再继续——不会在无人确认时
          继续自主执行；「拒绝并继续」保持会话永不挂起（旧行为）。
        </p>
        <label className={field}>
          <span>确认超时（分钟，默认 5）</span>
          <input
            className={fieldInput}
            type="number"
            min={1}
            step={1}
            value={permission?.timeoutMs !== undefined ? permission.timeoutMs / 60000 : 5}
            onChange={(e) => {
              const mins = Math.max(1, Number(e.target.value))
              if (Number.isFinite(mins)) onPermissionChange({ timeoutMs: mins * 60000 })
            }}
          />
        </label>
        <label className={field}>
          <span>超时后宽限期（分钟，默认 25）</span>
          <input
            className={fieldInput}
            type="number"
            min={1}
            step={1}
            value={permission?.expireGraceMs !== undefined ? permission.expireGraceMs / 60000 : 25}
            onChange={(e) => {
              const mins = Math.max(1, Number(e.target.value))
              if (Number.isFinite(mins)) onPermissionChange({ expireGraceMs: mins * 60000 })
            }}
          />
        </label>
        <p className={hint}>
          未显式设置时使用默认值：确认超时 5 分钟（超时仅提示，弹窗可重新确认）， 再过 25
          分钟仍未处理则自动拒绝。
        </p>
      </div>
    </>
  )
}

export { SecurityPanel }
