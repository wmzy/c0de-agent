import { css } from '@linaria/core'
import type { Config } from '@shared/types/config.js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTheme } from '../contexts/ThemeContext.js'
import { configAPI } from '../services/config.js'

const section = css`
  padding: 16px;
  border-bottom: 1px solid var(--border);
`

export function Settings() {
  const qc = useQueryClient()
  const { data: config, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => configAPI.get(),
  })
  const { mode, setMode } = useTheme()
  const [draft, setDraft] = useState<Partial<Config> | null>(null)
  const save = useMutation({
    mutationFn: (patch: Partial<Config>) => configAPI.update(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
  })

  if (isLoading || !config) return <div style={{ padding: 24 }}>加载中…</div>

  const merged = { ...config, ...draft }

  return (
    <div data-testid="settings" style={{ overflow: 'auto' }}>
      <div className={section}>
        <h3>主题</h3>
        <select value={mode} onChange={(e) => setMode(e.target.value as never)}>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
          <option value="system">跟随系统</option>
        </select>
      </div>
      <div className={section}>
        <h3>默认 Provider / Model</h3>
        <label>
          Provider:
          <input
            value={merged.defaultProvider}
            onChange={(e) => setDraft({ ...draft, defaultProvider: e.target.value })}
          />
        </label>
        <label>
          Model:
          <input
            value={merged.defaultModel}
            onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}
          />
        </label>
      </div>
      <div className={section}>
        <h3>启用工具</h3>
        <input
          value={merged.tools.enabled.join(', ')}
          onChange={(e) =>
            setDraft({
              ...draft,
              tools: {
                ...merged.tools,
                enabled: e.target.value.split(',').map((s) => s.trim()),
              },
            })
          }
        />
      </div>
      <div className={section}>
        <h3>压缩阈值</h3>
        <input
          type="number"
          step="0.05"
          value={merged.compaction.threshold}
          onChange={(e) =>
            setDraft({
              ...draft,
              compaction: {
                ...merged.compaction,
                threshold: Number(e.target.value),
              },
            })
          }
        />
      </div>
      <div className={section}>
        <button
          type="button"
          onClick={() => draft && save.mutate(draft)}
          disabled={!draft}
          data-testid="save-config"
        >
          保存
        </button>
      </div>
    </div>
  )
}
