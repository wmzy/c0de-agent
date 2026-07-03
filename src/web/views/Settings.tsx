import { css } from '@linaria/core'
import type { Config, MCPServerConfig } from '@shared/types/config.js'
import type { ModelOverride, ProviderConfig } from '@shared/types/llm.js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { ProviderCatalogDialog } from '../components/ProviderCatalogDialog.js'
import { useTheme } from '../contexts/ThemeContext.js'
import { configAPI } from '../services/config.js'
import type { TestResult } from '../services/provider.js'
import { providerAPI } from '../services/provider.js'

const section = css`
  padding: 16px;
  border-bottom: 1px solid var(--border);
`

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

const jsonWrap = css`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
`

const jsonTextarea = css`
  flex: 1;
  min-height: 420px;
  width: 100%;
  box-sizing: border-box;
  padding: 16px;
  border: none;
  background: var(--code-bg);
  color: var(--text);
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
  tab-size: 2;
  white-space: pre;
`

const jsonErrorBar = css`
  padding: 8px 16px;
  background: var(--diff-del-bg);
  color: var(--diff-del-text);
  font-size: 12px;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  word-break: break-all;
`

const jsonOkBar = css`
  padding: 6px 16px;
  background: var(--diff-add-bg);
  color: var(--diff-add-text);
  font-size: 12px;
`

const providerRow = css`
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr auto auto;
  gap: 8px;
  align-items: center;
  padding: 10px;
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
`

const testResultSpan = css`
  grid-column: 1 / -1;
  font-size: 0.85em;
`

/** 已加密保存徽章：apiKey 输入框旁的小提示，表示 key 已落盘。 */
const apiKeySavedBadge = css`
  font-size: 0.8em;
  color: var(--success, #2a9d8f);
  white-space: nowrap;
`

/** 保存状态提示文本。 */
const saveStatus = css`
  margin-left: 12px;
  font-size: 0.9em;
`

const buttonRow = css`
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
`

const sourceHint = css`
  font-size: 12px;
  color: var(--text-secondary);
`

const sourceLink = css`
  color: var(--primary);
  text-decoration: none;
  &:hover {
    text-decoration: underline;
  }
`

const modelPanel = css`
  grid-column: 1 / -1;
  margin-top: 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  padding: 8px;
`

const modelToolbar = css`
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
  flex-wrap: wrap;
`

const modelFilterInput = css`
  flex: 1;
  min-width: 120px;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
`

const modelToolbarBtn = css`
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text);
  font-size: 11px;
  cursor: pointer;
`

const modelCountText = css`
  font-size: 11px;
  color: var(--text-secondary);
`

const modelList = css`
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 160px;
  overflow-y: auto;
`

const modelRow = css`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 2px 4px;
`

const modelEmpty = css`
  font-size: 12px;
  color: var(--text-secondary);
  padding: 4px;
`

const field = css`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
`

const fieldInput = css`
  flex: 1;
  max-width: 320px;
`

const hint = css`
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
`

const checkRow = css`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  cursor: pointer;
`

const kvRow = css`
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
`

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

/** 解析逗号分隔的字符串数组（trim + 去空）。 */
function splitList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

/**
 * 逗号分隔列表输入。
 *
 * 内部维护原始文本缓冲，仅在「外部 value 解析结果与缓冲不一致」时同步，
 * 避免 value={array.join(', ')} + onChange=parseList 在每次按键时抹掉
 * 用户正在输入的分隔符：输入 "read," 会被 parse→join 还原成 "read"，
 * 导致逗号无法输入，最终保存时字段被清空（refresh 后恢复原值的根因）。
 */
function CommaListInput({
  value,
  onCommit,
  placeholder,
  className,
  type,
  id,
}: {
  value: string[]
  onCommit: (items: string[]) => void
  placeholder?: string
  className?: string
  type?: string
  id?: string
}) {
  const [text, setText] = useState(value.join(', '))
  const joined = value.join(', ')
  // 外部 value 变化（加载/导入/保存后刷新）时同步缓冲；
  // 解析结果一致则保留用户正在编辑的文本（含尾随分隔符）。
  useEffect(() => {
    setText((cur) => (splitList(cur).join(', ') === joined ? cur : joined))
  }, [joined])
  return (
    <input
      id={id}
      type={type}
      className={className}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value)
        onCommit(splitList(e.target.value))
      }}
    />
  )
}

/**
 * API Key 输入。
 *
 * 不回显已加密的密文（enc: 前缀）：否则用户改完 key、保存、刷新后会看到 enc: 串
 * （而非自己输入的 key），误以为「没保存」。已加密时输入框留空，旁边提示「已加密」；
 * 用户重新输入即覆盖。未改动时 draft 仍保留原 enc: 值，保存不会误清空。
 */
function ApiKeyInput({
  stored,
  onCommit,
}: {
  stored: string | undefined
  onCommit: (value: string) => void
}) {
  const [text, setText] = useState('')
  // 外部 stored 变化（加载、保存后刷新、导入）时同步显示：密文→留空，明文→原样。
  useEffect(() => {
    setText((stored ?? '').startsWith('enc:') ? '' : (stored ?? ''))
  }, [stored])
  const isEnc = (stored ?? '').startsWith('enc:')
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        type="password"
        value={text}
        placeholder={isEnc ? '已加密保存（重新输入以修改）' : 'API Key'}
        onChange={(e) => {
          setText(e.target.value)
          onCommit(e.target.value)
        }}
        data-testid="provider-apikey"
      />
      {isEnc && (
        <span className={apiKeySavedBadge} data-testid="provider-apikey-saved">
          ✓ 已加密
        </span>
      )}
    </span>
  )
}

export function Settings() {
  const qc = useQueryClient()
  const { data: config, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => configAPI.get(),
  })
  const { mode, setMode } = useTheme()
  const [draft, setDraft] = useState<Partial<Config> | null>(null)
  const [testResults, setTestResults] = useState<
    Record<number, { loading: boolean; result?: TestResult }>
  >({})
  const [modelFilter, setModelFilter] = useState<Record<number, string>>({})
  const [catalogOpen, setCatalogOpen] = useState(false)

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

  const addProviderFromCatalog = (provider: ProviderConfig) => {
    updateProviders([...merged.providers, provider])
  }

  if (isLoading || !config) return <div style={{ padding: 24 }}>加载中…</div>

  const merged = { ...config, ...draft }
  const isDirty = draft !== null

  // 默认 Provider/Model 候选来自已配置 provider 及其 models（仅启用的）。
  // defaultProvider 可能是 protocol 名或导入的陌生值，不在已配置列表时由 select 兜底显示。
  const defaultProviderCandidates = merged.providers.filter((p) => p.name.trim() !== '')
  const defaultProviderEntry = defaultProviderCandidates.find(
    (p) => p.name === merged.defaultProvider,
  )
  const defaultModelCandidates = Object.entries(defaultProviderEntry?.models ?? {})
    .filter(([, v]) => v.enabled !== false)
    .map(([name]) => name)

  // 切换默认 provider 时校正 model：新 provider 不含当前 model 则取首个启用模型。
  const changeDefaultProvider = (name: string) => {
    setDraft((prev) => {
      const base = prev ?? config
      const entry = (base.providers ?? []).find((p) => p.name === name)
      const models = entry?.models
        ? Object.entries(entry.models)
            .filter(([, v]) => v.enabled !== false)
            .map(([n]) => n)
        : []
      const keepModel = models.includes(base.defaultModel ?? '')
      return {
        ...base,
        defaultProvider: name,
        defaultModel: keepModel ? base.defaultModel : (models[0] ?? ''),
      }
    })
  }

  const updateProviders = (providers: ProviderConfig[]) => {
    setDraft((prev) => ({ ...prev, providers }))
  }

  const addProvider = () => {
    const newProvider: ProviderConfig = {
      name: '',
      protocol: 'openai-compat',
      apiKey: '',
      baseURL: '',
    }
    updateProviders([...merged.providers, newProvider])
  }

  const removeProvider = (index: number) => {
    const newProviders = merged.providers.filter((_, i) => i !== index)
    updateProviders(newProviders)
  }

  const updateProvider = (index: number, field: keyof ProviderConfig, value: string) => {
    const newProviders = merged.providers.map((p, i) =>
      i === index ? { ...p, [field]: value } : p,
    )
    updateProviders(newProviders)
  }

  /** 对某 provider 的 models 做任意变换，写回 draft。 */
  const updateModels = (
    providerIndex: number,
    fn: (models: Record<string, ModelOverride>) => Record<string, ModelOverride>,
  ) => {
    setDraft((prev) => {
      const base = prev ?? config
      const providers = (base.providers ?? []).map((p, i) =>
        i === providerIndex ? { ...p, models: fn(p.models ?? {}) } : p,
      )
      return { ...base, providers }
    })
  }

  /** 切换单个模型的启用状态。 */
  const toggleModel = (providerIndex: number, modelName: string) => {
    updateModels(providerIndex, (models) => {
      const next = { ...models }
      const cur = next[modelName] ?? {}
      next[modelName] = { ...cur, enabled: !(cur.enabled ?? true) }
      return next
    })
  }

  /** 全量启用/禁用该 provider 的所有模型。 */
  const setAllModels = (providerIndex: number, enabled: boolean) => {
    updateModels(providerIndex, (models) =>
      Object.fromEntries(Object.entries(models).map(([k, v]) => [k, { ...v, enabled }] as const)),
    )
  }

  const testProvider = async (index: number, baseURL: string, apiKey: string) => {
    setTestResults((prev) => ({ ...prev, [index]: { loading: true } }))
    try {
      const result = await providerAPI.test(baseURL, apiKey)
      setTestResults((prev) => ({ ...prev, [index]: { loading: false, result } }))
      // 测试成功时，把探测到的模型合并进 draft.providers[index].models，
      // 使保存后会话 ModelSelector 可选。保留 provider 已有的 ModelOverride，
      // 仅补全新检测到的模型。
      if (result.ok) {
        const detected = result.models
        setDraft((prev) => {
          const base = prev ?? config
          const providers = (base.providers ?? []).map((p, i) => {
            if (i !== index) return p
            const existing = p.models ?? {}
            const next = { ...existing }
            for (const m of detected) {
              if (!(m in next)) next[m] = {}
            }
            return { ...p, models: next }
          })
          return { ...base, providers }
        })
      }
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [index]: {
          loading: false,
          result: {
            ok: false,
            error: err instanceof Error ? err.message : '未知错误',
          },
        },
      }))
    }
  }

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

  // ---- MCP 服务器 (mcpServers) ----
  const addMcpServer = () => {
    setDraft((prev) => {
      const base = prev ?? config
      return {
        ...base,
        mcpServers: [...(base.mcpServers ?? []), { name: '', transport: 'stdio' }],
      }
    })
  }
  const updateMcpServer = (
    index: number,
    field: keyof MCPServerConfig,
    value: string | string[],
  ) => {
    setDraft((prev) => {
      const base = prev ?? config
      const servers = (base.mcpServers ?? []).map((s, i) =>
        i === index ? { ...s, [field]: value } : s,
      )
      return { ...base, mcpServers: servers }
    })
  }
  const removeMcpServer = (index: number) => {
    setDraft((prev) => {
      const base = prev ?? config
      return { ...base, mcpServers: (base.mcpServers ?? []).filter((_, i) => i !== index) }
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
    <div
      data-testid="settings"
      style={{ overflow: 'auto', display: 'flex', flexDirection: 'column' }}
    >
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
          style={{ display: 'none' }}
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
        <div className={jsonWrap}>
          <textarea
            className={jsonTextarea}
            value={jsonText}
            onChange={(e) => onJsonChange(e.target.value)}
            spellCheck={false}
            data-testid="settings-json-editor"
          />
          {jsonError ? (
            <div className={jsonErrorBar} data-testid="settings-json-error">
              ⚠ {jsonError}
            </div>
          ) : (
            <div className={jsonOkBar}>✓ JSON 合法，编辑实时同步到配置草稿</div>
          )}
        </div>
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
          <div className={section}>
            <h3>默认 Provider / Model</h3>
            {defaultProviderCandidates.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                请先在下方「LLM Provider」添加并配置 Provider，再选择默认值。
              </p>
            ) : (
              <>
                <label className={field}>
                  <span>Provider：</span>
                  <select
                    className={fieldInput}
                    value={merged.defaultProvider}
                    onChange={(e) => changeDefaultProvider(e.target.value)}
                    data-testid="default-provider-select"
                  >
                    {/* 当前值不在已配置列表时兜底显示，避免受控 select 丢失值 */}
                    {!defaultProviderCandidates.some(
                      (p) => p.name === merged.defaultProvider,
                    ) &&
                    merged.defaultProvider ? (
                      <option value={merged.defaultProvider}>
                        {merged.defaultProvider}（未配置）
                      </option>
                    ) : null}
                    {defaultProviderCandidates.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={field}>
                  <span>Model：</span>
                  <select
                    className={fieldInput}
                    value={merged.defaultModel}
                    onChange={(e) =>
                      setDraft((prev) => {
                        const base = prev ?? config
                        return { ...base, defaultModel: e.target.value }
                      })
                    }
                    data-testid="default-model-select"
                  >
                    {defaultModelCandidates.length === 0 ? (
                      <option value="">
                        {defaultProviderEntry ? '该 Provider 暂无模型，请先添加' : '请先选择 Provider'}
                      </option>
                    ) : null}
                    {!defaultModelCandidates.includes(merged.defaultModel) &&
                    merged.defaultModel ? (
                      <option value={merged.defaultModel}>
                        {merged.defaultModel}（未配置）
                      </option>
                    ) : null}
                    {defaultModelCandidates.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </div>
          <div className={section}>
            <h3>LLM Provider</h3>
            {merged.providers.map((provider, index) => {
              const test = testResults[index]
              const modelEntries = Object.entries(provider.models ?? {})
              const totalCount = modelEntries.length
              const enabledCount = modelEntries.filter(([, v]) => v.enabled !== false).length
              const filterText = (modelFilter[index] ?? '').toLowerCase()
              const filteredModels = filterText
                ? modelEntries.filter(([name]) => name.toLowerCase().includes(filterText))
                : modelEntries
              return (
                <div
                  // key 必须稳定：若依赖 name/baseURL，输入首字符即改变 key
                  // 导致该行卸载重建、输入框失焦。用 index 即可（受控表单列表）。
                  key={index}
                  className={providerRow}
                  data-testid="provider-row"
                >
                  <input
                    value={provider.name}
                    onChange={(e) => updateProvider(index, 'name', e.target.value)}
                    placeholder="名称"
                  />
                  <select
                    value={provider.protocol}
                    onChange={(e) => updateProvider(index, 'protocol', e.target.value)}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="google">Google</option>
                    <option value="openai-compat">OpenAI Compatible</option>
                  </select>
                  <input
                    value={provider.baseURL ?? ''}
                    onChange={(e) => updateProvider(index, 'baseURL', e.target.value)}
                    placeholder="https://api.openai.com/v1"
                  />
                  <ApiKeyInput
                    stored={provider.apiKey}
                    onCommit={(value) => updateProvider(index, 'apiKey', value)}
                  />
                  <button
                    type="button"
                    onClick={() => testProvider(index, provider.baseURL ?? '', provider.apiKey)}
                    disabled={test?.loading === true}
                    data-testid="provider-test"
                  >
                    {test?.loading ? '测试中…' : '测试'}
                  </button>
                  <button
                    type="button"
                    data-variant="danger"
                    onClick={() => removeProvider(index)}
                    data-testid="provider-remove"
                  >
                    删除
                  </button>
                  {test?.result && (
                    <span
                      className={testResultSpan}
                      style={{
                        color: test.result.ok ? 'var(--success)' : 'var(--error)',
                      }}
                    >
                      {test.result.ok
                        ? `\u2713 连接成功，${test.result.models.length} 个模型`
                        : `\u2717 ${test.result.error}`}
                    </span>
                  )}
                  {totalCount > 0 && (
                    <div className={modelPanel} data-testid="provider-models">
                      <div className={modelToolbar}>
                        <input
                          className={modelFilterInput}
                          value={modelFilter[index] ?? ''}
                          onChange={(e) =>
                            setModelFilter((prev) => ({ ...prev, [index]: e.target.value }))
                          }
                          placeholder="过滤模型…"
                          data-testid="provider-model-filter"
                        />
                        <button
                          type="button"
                          className={modelToolbarBtn}
                          onClick={() => setAllModels(index, true)}
                          data-testid="provider-models-enable-all"
                        >
                          启用所有
                        </button>
                        <button
                          type="button"
                          className={modelToolbarBtn}
                          onClick={() => setAllModels(index, false)}
                          data-testid="provider-models-disable-all"
                        >
                          禁用所有
                        </button>
                        <span className={modelCountText} data-testid="provider-models-count">
                          {enabledCount} / {totalCount} 已启用
                        </span>
                      </div>
                      <div className={modelList}>
                        {filteredModels.length === 0 ? (
                          <div className={modelEmpty}>无匹配模型</div>
                        ) : (
                          filteredModels.map(([name, override]) => {
                            const on = override.enabled !== false
                            return (
                              <label key={name} className={modelRow}>
                                <input
                                  type="checkbox"
                                  checked={on}
                                  onChange={() => toggleModel(index, name)}
                                  data-testid={`provider-model-toggle-${name}`}
                                />
                                <span>{name}</span>
                              </label>
                            )
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            <div className={buttonRow}>
              <button type="button" onClick={addProvider} data-testid="provider-add">
                + 手动添加
              </button>
              <button
                type="button"
                onClick={() => setCatalogOpen(true)}
                data-testid="provider-catalog"
              >
                从 models.dev 选择
              </button>
              <span className={sourceHint}>
                数据源：
                <a
                  className={sourceLink}
                  href="https://models.dev"
                  target="_blank"
                  rel="noreferrer"
                >
                  models.dev
                </a>
              </span>
            </div>
            {catalogOpen && (
              <ProviderCatalogDialog
                onClose={() => setCatalogOpen(false)}
                onSelect={addProviderFromCatalog}
              />
            )}
          </div>
          <div className={section}>
            <h3>角色路由</h3>
            <div className={hint} style={{ marginBottom: 8 }}>
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
          <div className={section}>
            <h3>上下文压缩</h3>
            <label className={checkRow}>
              <input
                type="checkbox"
                checked={merged.compaction.enabled}
                onChange={(e) => updateSection('compaction', { enabled: e.target.checked })}
              />
              <span>启用自动压缩</span>
            </label>
            <label className={field}>
              <span>触发阈值：</span>
              <input
                className={fieldInput}
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={merged.compaction.threshold}
                onChange={(e) => updateSection('compaction', { threshold: Number(e.target.value) })}
              />
            </label>
            <label className={field}>
              <span>保留 Token：</span>
              <input
                className={fieldInput}
                type="number"
                min={0}
                value={merged.compaction.reserveTokens}
                onChange={(e) =>
                  updateSection('compaction', { reserveTokens: Number(e.target.value) })
                }
              />
            </label>
            <label className={field}>
              <span>近期保留 Token：</span>
              <input
                className={fieldInput}
                type="number"
                min={0}
                value={merged.compaction.keepRecentTokens}
                onChange={(e) =>
                  updateSection('compaction', { keepRecentTokens: Number(e.target.value) })
                }
              />
            </label>
          </div>
          <div className={section}>
            <h3>工具配置</h3>
            <label className={field} htmlFor="cfg-tools-enabled">
              <span>已启用：</span>
              <CommaListInput
                id="cfg-tools-enabled"
                className={fieldInput}
                value={merged.tools.enabled}
                onCommit={(items) => updateSection('tools', { enabled: items })}
                placeholder="read, write, edit, glob, grep, bash"
              />
            </label>
            <label className={field} htmlFor="cfg-tools-disabled">
              <span>已禁用：</span>
              <CommaListInput
                id="cfg-tools-disabled"
                className={fieldInput}
                value={merged.tools.disabled}
                onCommit={(items) => updateSection('tools', { disabled: items })}
                placeholder="（无）"
              />
            </label>
            <div className={hint}>用逗号分隔工具名称。</div>
          </div>
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
          <div className={section}>
            <h3>MCP 服务器</h3>
            {(merged.mcpServers ?? []).map((server, index) => (
              // 受控表单列表用 index 作 key，避免输入 name 即重挂载失焦（同 providers 行）
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
            className={saveStatus}
            data-testid="settings-save-status"
            style={{
              color:
                saveFeedback.kind === 'ok'
                  ? 'var(--success, #2a9d8f)'
                  : saveFeedback.kind === 'err'
                    ? 'var(--error, #e63946)'
                    : 'var(--text-secondary)',
            }}
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
