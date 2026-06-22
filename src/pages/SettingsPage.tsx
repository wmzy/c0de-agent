import { useState } from 'react'
import { css } from '@linaria/core'
import { useNavigate } from 'react-router-dom'
import { Button, Input, Select, Option, Card } from 'haze-ui'
import { useConfig } from '../hooks/useConfig'
import { toast } from '../utils/toast'

const page = css`
  max-width: 480px;
  margin: 0 auto;
  padding: 48px 24px;
`

const title = css`
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 8px;
`

const subtitle = css`
  color: var(--haze-color-text-secondary);
  margin-bottom: 32px;
`

const formGroup = css`
  margin-bottom: 20px;
`

const label = css`
  display: block;
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 6px;
  color: var(--haze-color-text);
`

const presets = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'Ollama (本地)', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
  { name: '自定义', baseUrl: '', model: '' },
]

export default function SettingsPage() {
  const navigate = useNavigate()
  const { config, saveConfig } = useConfig()
  const [presetIndex, setPresetIndex] = useState(0)
  const [apiKey, setApiKey] = useState(config?.apiKey ?? '')
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? presets[0].baseUrl)
  const [model, setModel] = useState(config?.model ?? presets[0].model)
  const [isSaving, setIsSaving] = useState(false)

  const handlePresetChange = (index: number) => {
    setPresetIndex(index)
    setBaseUrl(presets[index].baseUrl)
    setModel(presets[index].model)
  }

  const handleSubmit = async () => {
    if (!apiKey.trim()) {
      toast.error('请输入 API Key')
      return
    }

    setIsSaving(true)
    try {
      await saveConfig({ apiKey, baseUrl, model })
      toast.success('配置已保存')
      navigate('/chat')
    } catch {
      toast.error('保存失败，请重试')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className={page}>
      <h1 className={title}>配置 Provider</h1>
      <p className={subtitle}>选择你的 AI 模型提供商并填写 API 密钥</p>

      <Card>
        <div className={formGroup}>
          <label className={label}>Provider 预设</label>
          <Select value={String(presetIndex)} onChange={(e) => handlePresetChange(Number(e.target.value))}>
            {presets.map((p, i) => (
              <Option key={i} value={String(i)}>
                {p.name}
              </Option>
            ))}
          </Select>
        </div>

        <div className={formGroup}>
          <label className={label}>API Key</label>
          <Input
            type="password"
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>

        <div className={formGroup}>
          <label className={label}>Base URL</label>
          <Input
            placeholder="https://api.openai.com/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>

        <div className={formGroup}>
          <label className={label}>Model</label>
          <Input placeholder="gpt-4o" value={model} onChange={(e) => setModel(e.target.value)} />
        </div>

        <Button onClick={handleSubmit} disabled={isSaving || !apiKey.trim()} style={{ width: '100%' }}>
          {isSaving ? '保存中...' : '保存并开始'}
        </Button>
      </Card>
    </div>
  )
}
