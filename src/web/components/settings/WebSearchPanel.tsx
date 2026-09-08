import type { Config } from '@shared/types/config.js'
import { ApiKeyInput } from './ApiKeyInput.js'
import { field, section, sectionTitle } from './styles.js'

interface WebSearchPanelProps {
  websearch: Config['websearch']
  onWebSearchChange: (patch: Partial<Config['websearch']>) => void
}

/** Web 搜索配置：后端选择及各后端所需的 API key（也可由环境变量提供）。
 *  key 落盘时加密（enc: 前缀），输入框不回显密文——与 provider apiKey 一致。 */
function WebSearchPanel({ websearch, onWebSearchChange }: WebSearchPanelProps) {
  return (
    <div className={section}>
      <h2 className={sectionTitle}>Web 搜索</h2>
      <label className={field}>
        <span>后端</span>
        <select
          value={websearch.provider}
          onChange={(e) =>
            onWebSearchChange({
              provider: e.target.value as Config['websearch']['provider'],
            })
          }
        >
          <option value="auto">自动</option>
          <option value="duckduckgo">DuckDuckGo</option>
          <option value="tavily">Tavily</option>
          <option value="brave">Brave</option>
        </select>
      </label>
      <div className={field}>
        <span>Tavily Key</span>
        <ApiKeyInput
          id="websearch-tavily-key"
          stored={websearch.tavilyApiKey}
          onCommit={(v) => onWebSearchChange({ tavilyApiKey: v })}
          testId="websearch-tavily-key-input"
        />
      </div>
      <div className={field}>
        <span>Brave Key</span>
        <ApiKeyInput
          id="websearch-brave-key"
          stored={websearch.braveApiKey}
          onCommit={(v) => onWebSearchChange({ braveApiKey: v })}
          testId="websearch-brave-key-input"
        />
      </div>
    </div>
  )
}

export { WebSearchPanel }
