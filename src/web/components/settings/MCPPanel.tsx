import { css } from '@linaria/core'
import type { MCPServerConfig } from '@shared/types/config.js'
import { section } from './styles.js'

const mcpRow = css`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 8px;
  margin-bottom: 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
`

interface MCPPanelProps {
  mcpServers: MCPServerConfig[]
  /** 函数式更新：Settings 在 setDraft 内对最新 draft.mcpServers 执行 updater。 */
  onMcpServersChange: (updater: (servers: MCPServerConfig[]) => MCPServerConfig[]) => void
}

/** MCP 服务器配置：增删改，按 transport 切换 command/args 与 url 字段。 */
function MCPPanel({ mcpServers, onMcpServersChange }: MCPPanelProps) {
  const addMcpServer = () => {
    onMcpServersChange((prev) => [...prev, { name: '', transport: 'stdio' }])
  }

  const updateMcpServer = (
    index: number,
    field: keyof MCPServerConfig,
    value: string | string[],
  ) => {
    onMcpServersChange((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)))
  }

  const removeMcpServer = (index: number) => {
    onMcpServersChange((prev) => prev.filter((_, i) => i !== index))
  }

  return (
    <div className={section}>
      <h3>MCP 服务器</h3>
      {mcpServers.map((server, index) => (
        // 受控表单列表用 index 作 key，避免输入 name 即重挂载失焦（同 providers 行）
        // biome-ignore lint/suspicious/noArrayIndexKey: 受控表单列表，name 输入会改 key 导致重挂载失焦
        <div key={index} className={mcpRow} data-testid="mcp-row">
          <input
            value={server.name}
            onChange={(e) => updateMcpServer(index, 'name', e.target.value)}
            placeholder="名称"
          />
          <select
            value={server.transport}
            onChange={(e) => updateMcpServer(index, 'transport', e.target.value)}
          >
            <option value="stdio">stdio</option>
            <option value="sse">sse</option>
            <option value="http">http</option>
          </select>
          {server.transport === 'stdio' ? (
            <>
              <input
                value={server.command ?? ''}
                onChange={(e) => updateMcpServer(index, 'command', e.target.value)}
                placeholder="command"
              />
              <input
                value={(server.args ?? []).join(' ')}
                onChange={(e) =>
                  updateMcpServer(index, 'args', e.target.value.split(/\s+/).filter(Boolean))
                }
                placeholder="args（空格分隔）"
              />
            </>
          ) : (
            <input
              value={server.url ?? ''}
              onChange={(e) => updateMcpServer(index, 'url', e.target.value)}
              placeholder="https://..."
            />
          )}
          <button
            type="button"
            data-variant="danger"
            onClick={() => removeMcpServer(index)}
            data-testid="mcp-remove"
          >
            删除
          </button>
        </div>
      ))}
      <button type="button" onClick={addMcpServer} data-testid="mcp-add">
        + 添加服务器
      </button>
    </div>
  )
}

export { MCPPanel }
