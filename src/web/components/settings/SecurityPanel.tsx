import type { Config } from '@shared/types/config.js'
import { CommaListInput } from './CommaListInput.js'
import { checkRow, field, fieldInput, hint, section, sectionTitle } from './styles.js'

interface SecurityPanelProps {
  security: Config['security']
  permission: Config['permission']
  onSecurityChange: (patch: Partial<Config['security']>) => void
  onPermissionChange: (patch: Partial<Config['permission']>) => void
}

/** 安全与权限配置：Bearer Token 认证、CORS 来源、以及启动时的默认授权模式。 */
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
            onChange={(e) => onSecurityChange({ authEnabled: e.target.checked })}
          />
          <span>启用 Bearer Token 认证</span>
        </label>
        {security.authEnabled && (
          <label className={field}>
            <span>Token：</span>
            <input
              className={fieldInput}
              type="password"
              value={security.token ?? ''}
              onChange={(e) => onSecurityChange({ token: e.target.value })}
              placeholder="Bearer Token"
            />
          </label>
        )}
        <label className={field} htmlFor="cfg-allowed-origins">
          <span>允许的 CORS 来源：</span>
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
          <span>默认模式：</span>
          <select
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
          启动时的默认授权模式。「自动授权」会跳过所有 ask 工具（含
          bash）的确认。此项为持久化默认值；Chat
          页顶部的「自动授权」开关为本次运行的临时切换，不会改写这里。
        </p>
      </div>
    </>
  )
}

export { SecurityPanel }
