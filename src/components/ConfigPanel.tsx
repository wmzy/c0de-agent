import { css } from '@linaria/core'
import { useState } from 'react'

const panelClass = css`
  padding: 24px;
  max-width: 480px;
  margin: 0 auto;
`

const titleClass = css`
  font-size: 20px;
  font-weight: bold;
  margin-bottom: 24px;
`

const fieldClass = css`
  margin-bottom: 16px;
`

const labelClass = css`
  display: block;
  font-size: 13px;
  color: #8b949e;
  margin-bottom: 6px;
`

const inputClass = css`
  width: 100%;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid #30363d;
  background: #161b22;
  color: #e6edf3;
  font-size: 14px;
  box-sizing: border-box;

  &:focus {
    outline: none;
    border-color: #1f6feb;
  }
`

const selectClass = css`
  width: 100%;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid #30363d;
  background: #161b22;
  color: #e6edf3;
  font-size: 14px;

  &:focus {
    outline: none;
    border-color: #1f6feb;
  }
`

const buttonClass = css`
  width: 100%;
  padding: 12px;
  border-radius: 6px;
  border: none;
  background: #238636;
  color: white;
  font-weight: bold;
  font-size: 14px;
  cursor: pointer;
  margin-top: 8px;

  &:hover {
    background: #2ea043;
  }

  &:disabled {
    background: #21262d;
    cursor: not-allowed;
  }
`

const presets = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
  { name: '自定义', baseUrl: '', model: '' },
]

interface Config {
  provider: string
  apiKey: string
  baseUrl: string
  model: string
}

interface ConfigPanelProps {
  onConfirm: (config: Config) => void
}

export function ConfigPanel({ onConfirm }: ConfigPanelProps) {
  const [preset, setPreset] = useState(0)
  const [config, setConfig] = useState<Config>({
    provider: 'OpenAI',
    apiKey: '',
    baseUrl: presets[0].baseUrl,
    model: presets[0].model,
  })

  const handlePresetChange = (index: number) => {
    setPreset(index)
    setConfig((prev) => ({
      ...prev,
      provider: presets[index].name,
      baseUrl: presets[index].baseUrl,
      model: presets[index].model,
    }))
  }

  const handleSubmit = () => {
    if (!config.apiKey) return
    onConfirm(config)
  }

  return (
    <div className={panelClass}>
      <div className={titleClass}>配置 Provider</div>

      <div className={fieldClass}>
        <label className={labelClass}>Provider 预设</label>
        <select
          className={selectClass}
          value={preset}
          onChange={(e) => handlePresetChange(Number(e.target.value))}
        >
          {presets.map((p, i) => (
            <option key={i} value={i}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className={fieldClass}>
        <label className={labelClass}>API Key</label>
        <input
          className={inputClass}
          type="password"
          placeholder="sk-..."
          value={config.apiKey}
          onChange={(e) => setConfig((prev) => ({ ...prev, apiKey: e.target.value }))}
        />
      </div>

      <div className={fieldClass}>
        <label className={labelClass}>Base URL</label>
        <input
          className={inputClass}
          placeholder="https://api.openai.com/v1"
          value={config.baseUrl}
          onChange={(e) => setConfig((prev) => ({ ...prev, baseUrl: e.target.value }))}
        />
      </div>

      <div className={fieldClass}>
        <label className={labelClass}>Model</label>
        <input
          className={inputClass}
          placeholder="gpt-4o"
          value={config.model}
          onChange={(e) => setConfig((prev) => ({ ...prev, model: e.target.value }))}
        />
      </div>

      <button className={buttonClass} onClick={handleSubmit} disabled={!config.apiKey}>
        开始使用
      </button>
    </div>
  )
}
