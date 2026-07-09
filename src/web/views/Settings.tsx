import { css } from '@linaria/core'
import type { Config } from '@shared/types/config.js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ChangeEvent, useRef, useState } from 'react'
import { CommaListInput } from '../components/settings/CommaListInput.js'
import { CompactionPanel } from '../components/settings/CompactionPanel.js'
import { JsonConfigEditor } from '../components/settings/JsonConfigEditor.js'
import { MCPPanel } from '../components/settings/MCPPanel.js'
import { ModelPanel } from '../components/settings/ModelPanel.js'
import { ProviderPanel } from '../components/settings/ProviderPanel.js'
import {
  checkRow,
  field,
  fieldInput,
  hint,
  hintMb,
  kvRow,
  section,
} from '../components/settings/styles.js'
import { ToolsPanel } from '../components/settings/ToolsPanel.js'
import { useTheme } from '../contexts/ThemeContext.js'
import { configAPI } from '../services/config.js'

const toolbar = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  position: sticky;
  top: 0;
  z-index: 10;
  flex-wrap: wrap;
`

const toolbarTitle = css`
  font-size: 15px;
  font-weight: 600;
  margin-right: auto;
`

const segGroup = css`
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
`

const segBtn = css`
  padding: 4px 12px;
  border: none;
  border-right: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  &:last-child {
    border-right: none;
  }
`

const segBtnActive = css`
  background: var(--primary);
  color: #fff;
`

const toolBtn = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
  &:hover {
    background: var(--bg-secondary);
  }
`

/** 加载中占位。 */
const loadingWrap = css`
  padding: 24px;
`

/** Settings 根滚动容器。 */
const settingsScroll = css`
  overflow: auto;
  display: flex;
  flex-direction: column;
`

/** 隐藏的 file input。 */
const hiddenInput = css`
  display: none;
`

/** 保存反馈 — 成功色。 */
const saveOk = css`
  color: var(--success, #2a9d8f);
`

/** 保存反馈 — 错误色。 */
const saveErr = css`
  color: var(--error, #e63946);
`

/** 保存状态提示文本。 */
const saveStatus = css`
  margin-left: 12px;
  font-size: 0.9em;
`

export function Settings() {
  const qc = useQueryClient()
  const { data: config, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => configAPI.get(),
  })
  const { mode, setMode } = useTheme()
  const [draft, setDraft] = useState<Partial<Config> | null>(null)

  // 视图模式：GUI 表单 / JSON 直接编辑（参考 VSCode settings 切换）
  const [viewMode, setViewMode] = useState<'gui' | 'json'>('gui')
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 保存反馈：idle/saving/ok/err，ok 在 2.5s 后自动清除。
  const [saveFeedback, setSaveFeedback] = useState<
    { kind: 'idle' } | { kind: 'saving' } | { kind: 'ok' } | { kind: 'err'; msg: string }
  >({ kind: 'idle' })

  const save = useMutation({
    mutationFn: (patch: Partial<Config>) => configAPI.update(patch),
    onMutate: () => setSaveFeedback({ kind: 'saving' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config'] })
      // 清除草稿：表单回退到已持久化状态（apiKey 输入不再回显明文，统一显示「已加密」），
      // isDirty 重置为 false，保存按钮禁用直到下一次编辑。
      setDraft(null)
      setSaveFeedback({ kind: 'ok' })
      setTimeout(() => setSaveFeedback((s) => (s.kind === 'ok' ? { kind: 'idle' } : s)), 2500)
    },
    onError: (err: unknown) => {
      const msg =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: string }).message)
          : '未知错误'
      setSaveFeedback({ kind: 'err', msg })
    },
  })

  if (isLoading || !config) return <div className={loadingWrap}>加载中…</div>

  const merged = { ...config, ...draft }
  const isDirty = draft !== null

  /**
   * 通用嵌套对象字段更新（浅合并）。适用于 compaction/fallback/tools/
   * toolMetrics/security/websearch/agents/plugins/slashCommands。
   */
  const updateSection = <K extends keyof Config>(
    key: K,
    patch: Partial<NonNullable<Config[K]>>,
  ) => {
    setDraft((prev) => {
      const base = prev ?? config
      const current = (base[key] ?? {}) as object
      return { ...base, [key]: { ...current, ...patch } }
    })
  }

  /** 在最新 draft 上叠加顶层标量 patch（defaultProvider/defaultModel 等）。 */
  const patchDraft = (patch: Partial<Config>) =>
    setDraft((prev) => ({ ...(prev ?? config), ...patch }))

  /** 函数式更新 providers：在最新 draft.providers 上执行 updater（异步测试连接安全）。 */
  const updateProviders = (updater: (providers: Config['providers']) => Config['providers']) =>
    setDraft((prev) => {
      const base = prev ?? config
      return { ...base, providers: updater(base.providers ?? []) }
    })

  /** 函数式更新 mcpServers：在最新 draft.mcpServers 上执行 updater。 */
  const updateMcpServers = (updater: (servers: Config['mcpServers']) => Config['mcpServers']) =>
    setDraft((prev) => {
      const base = prev ?? config
      return { ...base, mcpServers: updater(base.mcpServers ?? []) }
    })

  // ---- 角色路由 (roleRouting) ----
  const addRoleRouting = () => {
    setDraft((prev) => {
      const base = prev ?? config
      const routing = { ...(base.roleRouting ?? {}) }
      routing[`role-${Object.keys(routing).length + 1}`] = { provider: '', model: '' }
      return { ...base, roleRouting: routing }
    })
  }
  const updateRoleRouting = (role: string, field: 'provider' | 'model', value: string) => {
    setDraft((prev) => {
      const base = prev ?? config
      const routing = { ...(base.roleRouting ?? {}) }
      routing[role] = { ...(routing[role] ?? { provider: '', model: '' }), [field]: value }
      return { ...base, roleRouting: routing }
    })
  }
  const removeRoleRouting = (role: string) => {
    setDraft((prev) => {
      const base = prev ?? config
      const routing = { ...(base.roleRouting ?? {}) }
      delete routing[role]
      return { ...base, roleRouting: routing }
    })
  }
  const renameRoleRouting = (oldKey: string, newKey: string) => {
    setDraft((prev) => {
      const base = prev ?? config
      const entries = Object.entries(base.roleRouting ?? {})
      return {
        ...base,
        roleRouting: Object.fromEntries(
          entries.map(([k, v]) => (k === oldKey ? [newKey, v] : [k, v])),
        ),
      }
    })
  }

  // ---- JSON 模式 / 导入导出 ----

  /** 进入 JSON 模式：以当前合并配置序列化为初始文本。 */
  const enterJsonMode = () => {
    setJsonText(JSON.stringify(merged, null, 2))
    setJsonError(null)
    setViewMode('json')
  }

  /** JSON 文本变更：实时解析，合法则同步 draft，非法仅提示。 */
  const onJsonChange = (text: string) => {
    setJsonText(text)
    try {
      const parsed = JSON.parse(text) as Partial<Config>
      setJsonError(null)
      setDraft(parsed)
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : 'JSON 解析错误')
    }
  }

  /** 切回 GUI：JSON 非法时阻止（避免丢失未保存的编辑）。 */
  const enterGuiMode = () => {
    if (viewMode === 'json' && jsonError) return
    setViewMode('gui')
  }

  /** 导出当前配置为 c0de-config.json。 */
  const exportConfig = () => {
    const text = viewMode === 'json' && !jsonError ? jsonText : JSON.stringify(merged, null, 2)
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'c0de-config.json'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  /** 从文件导入配置。 */
  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as Partial<Config>
      setDraft(parsed)
      setJsonText(JSON.stringify(parsed, null, 2))
      setJsonError(null)
      setViewMode('gui')
    } catch (err) {
      setJsonError(`导入失败：${err instanceof Error ? err.message : '未知错误'}`)
      setViewMode('json')
      // 把读取到的原始文本放进编辑器方便定位问题
      try {
        setJsonText(await file.text())
      } catch {
        /* ignore */
      }
    }
    e.target.value = '' // 允许重复导入同一文件
  }

  return (
    <div className={settingsScroll} data-testid="settings">
      <div className={toolbar}>
        <span className={toolbarTitle}>⚙ 设置</span>
        <div className={segGroup}>
          <button
            type="button"
            className={`${segBtn} ${viewMode === 'gui' ? segBtnActive : ''}`}
            onClick={enterGuiMode}
            data-testid="settings-mode-gui"
          >
            表单
          </button>
          <button
            type="button"
            className={`${segBtn} ${viewMode === 'json' ? segBtnActive : ''}`}
            onClick={enterJsonMode}
            data-testid="settings-mode-json"
          >
            {'{ } JSON'}
          </button>
        </div>
        <button
          type="button"
          className={toolBtn}
          onClick={() => fileInputRef.current?.click()}
          data-testid="settings-import"
          title="从 JSON 文件导入配置"
        >
          ⬆ 导入
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className={hiddenInput}
          onChange={(e) => void onImportFile(e)}
          data-testid="settings-import-input"
        />
        <button
          type="button"
          className={toolBtn}
          onClick={exportConfig}
          data-testid="settings-export"
          title="导出当前配置为 JSON 文件"
        >
          ⬇ 导出
        </button>
      </div>

      {viewMode === 'json' ? (
        <JsonConfigEditor jsonText={jsonText} jsonError={jsonError} onChange={onJsonChange} />
      ) : (
        <>
          <div className={section}>
            <h3>外观</h3>
            <label className={field}>
              <span>主题：</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as never)}>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
                <option value="system">跟随系统</option>
              </select>
            </label>
            <label className={field}>
              <span>语言：</span>
              <select
                value={merged.locale}
                onChange={(e) => setDraft((prev) => ({ ...prev, locale: e.target.value }))}
              >
                <option value="zh-CN">简体中文</option>
                <option value="en">English</option>
              </select>
            </label>
          </div>
          <ProviderPanel providers={merged.providers} onProvidersChange={updateProviders} />
          <ModelPanel
            providers={merged.providers}
            defaultProvider={merged.defaultProvider}
            defaultModel={merged.defaultModel}
            onChange={patchDraft}
          />
          <div className={section}>
            <h3>角色路由</h3>
            <div className={`${hint} ${hintMb}`}>
              为特定角色指定独立的 provider 和 model（覆盖默认）。
            </div>
            {Object.entries(merged.roleRouting ?? {}).map(([role, cfg]) => (
              <div key={role} className={kvRow}>
                <input
                  value={role}
                  placeholder="角色名"
                  onChange={(e) => renameRoleRouting(role, e.target.value)}
                />
                <input
                  value={cfg.provider}
                  placeholder="provider"
                  onChange={(e) => updateRoleRouting(role, 'provider', e.target.value)}
                />
                <input
                  value={cfg.model}
                  placeholder="model"
                  onChange={(e) => updateRoleRouting(role, 'model', e.target.value)}
                />
                <button type="button" data-variant="danger" onClick={() => removeRoleRouting(role)}>
                  删除
                </button>
              </div>
            ))}
            <button type="button" onClick={addRoleRouting} data-testid="role-add">
              + 添加角色
            </button>
          </div>
          <div className={section}>
            <h3>故障回退</h3>
            <label className={checkRow}>
              <input
                type="checkbox"
                checked={merged.fallback.enabled}
                onChange={(e) => updateSection('fallback', { enabled: e.target.checked })}
              />
              <span>启用自动重试与回退</span>
            </label>
            <label className={field}>
              <span>最大重试次数：</span>
              <input
                className={fieldInput}
                type="number"
                min={0}
                value={merged.fallback.maxRetries}
                onChange={(e) => updateSection('fallback', { maxRetries: Number(e.target.value) })}
              />
            </label>
            <label className={field}>
              <span>重试间隔 (ms)：</span>
              <input
                className={fieldInput}
                type="number"
                min={0}
                value={merged.fallback.retryDelay}
                onChange={(e) => updateSection('fallback', { retryDelay: Number(e.target.value) })}
              />
            </label>
          </div>
          <CompactionPanel
            compaction={merged.compaction}
            providers={merged.providers}
            defaultProvider={merged.defaultProvider}
            defaultModel={merged.defaultModel}
            onCompactionChange={(patch) => updateSection('compaction', patch)}
          />
          <ToolsPanel
            tools={merged.tools}
            onToolsChange={(patch) => updateSection('tools', patch)}
          />
          <div className={section}>
            <h3>工具指标</h3>
            <label className={checkRow}>
              <input
                type="checkbox"
                checked={merged.toolMetrics.enabled}
                onChange={(e) => updateSection('toolMetrics', { enabled: e.target.checked })}
              />
              <span>启用工具模式自动选择</span>
            </label>
            <label className={field}>
              <span>成功率阈值：</span>
              <input
                className={fieldInput}
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={merged.toolMetrics.threshold}
                onChange={(e) =>
                  updateSection('toolMetrics', { threshold: Number(e.target.value) })
                }
              />
            </label>
            <label className={field}>
              <span>最小样本数：</span>
              <input
                className={fieldInput}
                type="number"
                min={0}
                value={merged.toolMetrics.minSamples}
                onChange={(e) =>
                  updateSection('toolMetrics', { minSamples: Number(e.target.value) })
                }
              />
            </label>
          </div>
          <div className={section}>
            <h3>插件</h3>
            <CommaListInput
              value={merged.plugins.enabled}
              onCommit={(items) => updateSection('plugins', { enabled: items })}
              placeholder="plugin-a, plugin-b"
            />
            <div className={hint}>用逗号分隔已启用的插件名称。</div>
          </div>
          <div className={section}>
            <h3>斜杠命令</h3>
            <CommaListInput
              value={merged.slashCommands.enabled}
              onCommit={(items) => updateSection('slashCommands', { enabled: items })}
              placeholder="/compact, /model, /clear"
            />
            <div className={hint}>用逗号分隔已启用的斜杠命令。</div>
          </div>
          <MCPPanel mcpServers={merged.mcpServers} onMcpServersChange={updateMcpServers} />
          <div className={section}>
            <h3>Web 搜索</h3>
            <label className={field}>
              <span>后端：</span>
              <select
                value={merged.websearch.provider}
                onChange={(e) =>
                  updateSection('websearch', {
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
                value={merged.websearch.tavilyApiKey ?? ''}
                onChange={(e) => updateSection('websearch', { tavilyApiKey: e.target.value })}
                placeholder="（可由环境变量 TAVILY_API_KEY 提供）"
              />
            </label>
            <label className={field}>
              <span>Brave Key：</span>
              <input
                className={fieldInput}
                type="password"
                value={merged.websearch.braveApiKey ?? ''}
                onChange={(e) => updateSection('websearch', { braveApiKey: e.target.value })}
                placeholder="（可由环境变量 BRAVE_API_KEY 提供）"
              />
            </label>
          </div>
          <div className={section}>
            <h3>多 Agent</h3>
            <label className={field}>
              <span>Agent 目录：</span>
              <input
                className={fieldInput}
                value={merged.agents.dir}
                onChange={(e) => updateSection('agents', { dir: e.target.value })}
                placeholder=".c0de/agents"
              />
            </label>
            <label className={field}>
              <span>子 Agent 并发数：</span>
              <input
                className={fieldInput}
                type="number"
                min={1}
                value={merged.agents.subagentConcurrency}
                onChange={(e) =>
                  updateSection('agents', { subagentConcurrency: Number(e.target.value) })
                }
              />
            </label>
          </div>
          <div className={section}>
            <h3>安全</h3>
            <label className={checkRow}>
              <input
                type="checkbox"
                checked={merged.security.authEnabled}
                onChange={(e) => updateSection('security', { authEnabled: e.target.checked })}
              />
              <span>启用 Bearer Token 认证</span>
            </label>
            {merged.security.authEnabled && (
              <label className={field}>
                <span>Token：</span>
                <input
                  className={fieldInput}
                  type="password"
                  value={merged.security.token ?? ''}
                  onChange={(e) => updateSection('security', { token: e.target.value })}
                  placeholder="Bearer Token"
                />
              </label>
            )}
            <label className={field} htmlFor="cfg-allowed-origins">
              <span>允许的 CORS 来源：</span>
              <CommaListInput
                id="cfg-allowed-origins"
                className={fieldInput}
                value={merged.security.allowedOrigins}
                onCommit={(items) => updateSection('security', { allowedOrigins: items })}
                placeholder="（本地回环始终允许）"
              />
            </label>
          </div>
          <div className={section}>
            <h3>自动授权</h3>
            <label className={field}>
              <span>默认模式：</span>
              <select
                value={merged.permission?.defaultMode ?? 'default'}
                onChange={(e) =>
                  updateSection('permission', {
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
      )}

      <div className={section}>
        <button
          type="button"
          onClick={() => draft && save.mutate(draft)}
          disabled={!isDirty || saveFeedback.kind === 'saving'}
          title={isDirty ? '保存配置' : '配置未变更或正在加载'}
          data-testid="settings-save"
        >
          {saveFeedback.kind === 'saving' ? '保存中…' : '保存'}
        </button>
        {saveFeedback.kind !== 'idle' && (
          <span
            className={`${saveStatus} ${
              saveFeedback.kind === 'ok' ? saveOk : saveFeedback.kind === 'err' ? saveErr : ''
            }`}
            data-testid="settings-save-status"
          >
            {saveFeedback.kind === 'saving' && '保存中…'}
            {saveFeedback.kind === 'ok' && '✓ 已保存'}
            {saveFeedback.kind === 'err' && `✗ 保存失败：${saveFeedback.msg}`}
          </span>
        )}
      </div>
    </div>
  )
}
