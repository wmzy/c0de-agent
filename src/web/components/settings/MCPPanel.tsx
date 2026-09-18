import { css } from '@linaria/core'
import type { MCPServerConfig } from '@shared/types/config.js'
import { Button } from 'haze-ui'
import { SyncedInput, SyncedSelect } from '@/components/SyncedControls.js'
import { section, sectionTitle } from '@/components/settings/styles.js'
import { btnDanger } from '@/styles/tokens.js'

const mcpRow = css`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 8px;
  margin-bottom: 6px;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg-subtle);
`

const mcpNotice = css`
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--haze-color-warning);
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
      <h2 className={sectionTitle}>MCP 服务器</h2>
      <span className={mcpNotice} data-testid="mcp-unimplemented-notice">
        MCP 服务器当前未接入工具加载：此处配置会被保存，但不会向 AI 暴露任何工具（功能未生效）。
      </span>
      {mcpServers.map((server, index) => (
        // 受控表单列表用 index 作 key，避免输入 name 即重挂载失焦（同 providers 行）
        // biome-ignore lint/suspicious/noArrayIndexKey: 受控表单列表，name 输入会改 key 导致重挂载失焦
        <div key={index} className={mcpRow} data-testid="mcp-row">
          <SyncedInput
            value={server.name}
            onChange={(v) => updateMcpServer(index, 'name', v)}
            placeholder="名称"
          />
          <SyncedSelect
            value={server.transport}
            onValuesChange={(v) => updateMcpServer(index, 'transport', v)}
          >
            <option value="stdio">stdio</option>
            <option value="sse">sse</option>
            <option value="http">http</option>
          </SyncedSelect>
          {server.transport === 'stdio' ? (
            <>
              <SyncedInput
                value={server.command ?? ''}
                onChange={(v) => updateMcpServer(index, 'command', v)}
                placeholder="command"
              />
              <SyncedInput
                value={(server.args ?? []).join(' ')}
                onChange={(v) => updateMcpServer(index, 'args', v.split(/\s+/).filter(Boolean))}
                placeholder="args（空格分隔）"
              />
            </>
          ) : (
            <SyncedInput
              value={server.url ?? ''}
              onChange={(v) => updateMcpServer(index, 'url', v)}
              placeholder="https://..."
            />
          )}
          <Button
            className={btnDanger}
            variant="outline"
            onClick={() => removeMcpServer(index)}
            data-testid="mcp-remove"
          >
            删除
          </Button>
        </div>
      ))}
      <Button onClick={addMcpServer} data-testid="mcp-add" variant="outline">
        + 添加服务器
      </Button>
    </div>
  )
}

export { MCPPanel }
