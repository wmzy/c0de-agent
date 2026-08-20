import type { Config } from '@shared/types/config.js'
import { field, fieldInput, section, sectionTitle } from './styles.js'

interface WebSearchPanelProps {
  websearch: Config['websearch']
  onWebSearchChange: (patch: Partial<Config['websearch']>) => void
}

/** Web 搜索配置：后端选择及各后端所需的 API key（也可由环境变量提供）。 */
function WebSearchPanel({ websearch, onWebSearchChange }: WebSearchPanelProps) {
  return (
    <div className={section}>
      <h2 className={sectionTitle}>Web 搜索</h2>
      <label className={field}>
        <span>后端：</span>
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
      <label className={field}>
        <span>Tavily Key：</span>
        <input
          className={fieldInput}
          type="password"
          value={websearch.tavilyApiKey ?? ''}
          onChange={(e) => onWebSearchChange({ tavilyApiKey: e.target.value })}
          placeholder="（可由环境变量 TAVILY_API_KEY 提供）"
        />
      </label>
      <label className={field}>
        <span>Brave Key：</span>
        <input
          className={fieldInput}
          type="password"
          value={websearch.braveApiKey ?? ''}
          onChange={(e) => onWebSearchChange({ braveApiKey: e.target.value })}
          placeholder="（可由环境变量 BRAVE_API_KEY 提供）"
        />
      </label>
    </div>
  )
}

export { WebSearchPanel }
