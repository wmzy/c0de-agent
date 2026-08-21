import type { Config } from '@shared/types/config.js'
import { CommaListInput } from './CommaListInput.js'
import { field, fieldInput, hint, section, sectionTitle } from './styles.js'

interface ToolsPanelProps {
  tools: Config['tools']
  onToolsChange: (patch: Partial<Config['tools']>) => void
}

/** 工具配置：启用 / 禁用工具名（逗号分隔）。 */
function ToolsPanel({ tools, onToolsChange }: ToolsPanelProps) {
  return (
    <div className={section}>
      <h2 className={sectionTitle}>工具配置</h2>
      <label className={field} htmlFor="cfg-tools-enabled">
        <span>已启用</span>
        <CommaListInput
          id="cfg-tools-enabled"
          className={fieldInput}
          value={tools.enabled}
          onCommit={(items) => onToolsChange({ enabled: items })}
          placeholder="read, write, edit, glob, grep, bash"
        />
      </label>
      <label className={field} htmlFor="cfg-tools-disabled">
        <span>已禁用</span>
        <CommaListInput
          id="cfg-tools-disabled"
          className={fieldInput}
          value={tools.disabled}
          onCommit={(items) => onToolsChange({ disabled: items })}
          placeholder="（无）"
        />
      </label>
      <div className={hint}>用逗号分隔工具名称。</div>
    </div>
  )
}

export { ToolsPanel }
