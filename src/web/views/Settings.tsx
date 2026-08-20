import { css } from '@linaria/core'
import type { Config } from '@shared/types/config.js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { Dialog } from '../components/Dialog.js'
import { AppearancePanel } from '../components/settings/AppearancePanel.js'
import { CommaListInput } from '../components/settings/CommaListInput.js'
import { CompactionPanel } from '../components/settings/CompactionPanel.js'
import { FallbackPanel } from '../components/settings/FallbackPanel.js'
import { GitPanel } from '../components/settings/GitPanel.js'
import { JsonConfigEditor } from '../components/settings/JsonConfigEditor.js'
import { MCPPanel } from '../components/settings/MCPPanel.js'
import { ModelPanel } from '../components/settings/ModelPanel.js'
import { ProviderPanel } from '../components/settings/ProviderPanel.js'
import { SecurityPanel } from '../components/settings/SecurityPanel.js'
import {
  checkRow,
  field,
  fieldInput,
  hint,
  hintMb,
  kvRow,
  section,
  sectionTitle,
} from '../components/settings/styles.js'
import { ToolsPanel } from '../components/settings/ToolsPanel.js'
import { WebSearchPanel } from '../components/settings/WebSearchPanel.js'
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
  font-size: 0.9em;
`

/** 吸底保存条：sticky 于设置滚动容器底部；有未保存更改时强调，无更改时弱化。 */
const saveBar = css`
  position: sticky;
  bottom: 0;
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border);
  z-index: 10;
`

/** 有未保存更改时的强调：上浮阴影 + 主色分隔线。 */
const saveBarDirty = css`
  border-top-color: color-mix(in srgb, var(--primary) 40%, var(--border));
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.12);
`

/** 保存条中间弹性占位：提示靠左、按钮靠右。 */
const saveBarSpacer = css`
  flex: 1;
`

/** 「未保存更改」提示：警示色。 */
const dirtyHint = css`
  color: var(--warning);
  font-size: 13px;
`

/** 离开确认弹窗正文。 */
const dialogBody = css`
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
`

/** 离开确认弹窗底部按钮组。 */
const dialogActions = css`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
`

export function Settings() {
  const qc = useQueryClient()
  const { data: config, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => configAPI.get(),
  })
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

  // 未保存导航防护：待确认的离开链接；bypass 标记放行「离开」确认后的重放点击。
  const [pendingLeave, setPendingLeave] = useState<{
    el: HTMLAnchorElement
    href: string
  } | null>(null)
  const bypassGuardRef = useRef(false)

  // dirty 仅指「需手动保存的草稿」；外观面板即时生效、不进 draft，不影响此判定。
  const isDirty = draft !== null

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

  // SPA 内部导航防护：App 使用 BrowserRouter（非 data router），useBlocker 不可用，
  // 改为捕获阶段拦截站内 <a> 点击（TopBar 等 Link 最终渲染为 <a href>）；
  // preventDefault 后 react-router Link 的 onClick（先查 defaultPrevented）会放弃导航。
  useEffect(() => {
    if (!isDirty) return
    const onClick = (e: MouseEvent) => {
      if (bypassGuardRef.current) {
        bypassGuardRef.current = false // 「离开」确认后的重放点击，放行一次
        return
      }
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return
      }
      const el = (e.target as HTMLElement | null)?.closest('a[href]')
      if (!(el instanceof HTMLAnchorElement)) return
      if (el.target && el.target !== '_self') return
      if (el.hasAttribute('download')) return
      let url: URL
      try {
        url = new URL(el.getAttribute('href') ?? '', window.location.href)
      } catch {
        return
      }
      // 仅拦截同源且离开设置页的导航（导出用的 blob: 链接不同源，天然跳过）
      if (url.origin !== window.location.origin) return
      if (url.pathname.startsWith('/settings')) return
      e.preventDefault()
      setPendingLeave({ el, href: url.href })
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [isDirty])

  // 刷新/关闭页面前提示；SPA 内部导航不触发 beforeunload，由上面的拦截负责。
  useEffect(() => {
    if (!isDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isDirty])

  if (isLoading || !config) return <div className={loadingWrap}>加载中…</div>

  const merged = { ...config, ...draft }

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

  /** 放弃未保存的更改：草稿清空回退到已持久化配置（JSON 模式同步重置编辑器）。 */
  const discardChanges = () => {
    setDraft(null)
    if (viewMode === 'json') {
      setJsonText(JSON.stringify(config, null, 2))
      setJsonError(null)
    }
  }

  /** 离开确认弹窗：「留下」= 关闭弹窗，留在设置页继续编辑。 */
  const stayOnSettings = () => setPendingLeave(null)

  /** 离开确认弹窗：「离开」= 丢弃草稿并重放被拦截的链接点击（放行一次）。 */
  const confirmLeave = () => {
    const pending = pendingLeave
    setPendingLeave(null)
    setDraft(null)
    if (!pending) return
    bypassGuardRef.current = true
    if (pending.el.isConnected) pending.el.click()
    else window.location.assign(pending.href)
  }

  return (
    <div className={settingsScroll} data-testid="settings">
      <div className={toolbar}>
        <h1 className={toolbarTitle}>⚙ 设置</h1>
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
          <AppearancePanel
            locale={merged.locale}
            onLocaleChange={(locale) => patchDraft({ locale })}
          />
          <ProviderPanel providers={merged.providers} onProvidersChange={updateProviders} />
          <ModelPanel
            providers={merged.providers}
            defaultProvider={merged.defaultProvider}
            defaultModel={merged.defaultModel}
            onChange={patchDraft}
          />
          <div className={section}>
            <h2 className={sectionTitle}>角色路由</h2>
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
          <FallbackPanel
            fallback={merged.fallback}
            onFallbackChange={(patch) => updateSection('fallback', patch)}
          />
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
          <GitPanel
            commitModel={merged.commitModel}
            providers={merged.providers}
            defaultProvider={merged.defaultProvider}
            defaultModel={merged.defaultModel}
            onCommitModelChange={(patch) => patchDraft(patch)}
          />
          <div className={section}>
            <h2 className={sectionTitle}>工具指标</h2>
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
            <h2 className={sectionTitle}>插件</h2>
            <CommaListInput
              value={merged.plugins.enabled}
              onCommit={(items) => updateSection('plugins', { enabled: items })}
              placeholder="plugin-a, plugin-b"
            />
            <div className={hint}>用逗号分隔已启用的插件名称。</div>
          </div>
          <div className={section}>
            <h2 className={sectionTitle}>斜杠命令</h2>
            <CommaListInput
              value={merged.slashCommands.enabled}
              onCommit={(items) => updateSection('slashCommands', { enabled: items })}
              placeholder="/compact, /model, /clear"
            />
            <div className={hint}>用逗号分隔已启用的斜杠命令。</div>
          </div>
          <MCPPanel mcpServers={merged.mcpServers} onMcpServersChange={updateMcpServers} />
          <WebSearchPanel
            websearch={merged.websearch}
            onWebSearchChange={(patch) => updateSection('websearch', patch)}
          />
          <div className={section}>
            <h2 className={sectionTitle}>多 Agent</h2>
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
          <SecurityPanel
            security={merged.security}
            permission={merged.permission}
            onSecurityChange={(patch) => updateSection('security', patch)}
            onPermissionChange={(patch) => updateSection('permission', patch)}
          />
        </>
      )}

      {/* 吸底保存条：有未保存更改时强调并给出「放弃更改」，无更改时弱化为禁用保存 */}
      <div
        className={`${saveBar} ${isDirty ? saveBarDirty : ''}`}
        data-testid="settings-save-bar"
      >
        {isDirty && (
          <span className={dirtyHint} data-testid="settings-dirty-hint">
            ● 未保存更改
          </span>
        )}
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
        <span className={saveBarSpacer} />
        {isDirty && (
          <button
            type="button"
            onClick={discardChanges}
            data-testid="settings-discard"
            title="放弃当前未保存的修改，恢复到已保存配置"
          >
            放弃更改
          </button>
        )}
        <button
          type="button"
          data-variant="primary"
          onClick={() => draft && save.mutate(draft)}
          disabled={!isDirty || saveFeedback.kind === 'saving'}
          title={isDirty ? '保存配置' : '配置未变更或正在加载'}
          data-testid="settings-save"
        >
          {saveFeedback.kind === 'saving' ? '保存中…' : '保存'}
        </button>
      </div>

      {/* 未保存更改离开确认：弹窗遮罩阻断交互，「留下」恢复编辑，「离开」放行导航 */}
      <Dialog
        open={pendingLeave != null}
        onClose={stayOnSettings}
        title="未保存的更改"
        width="min(420px, 92vw)"
        testId="settings-unsaved-dialog"
        footer={
          <div className={dialogActions}>
            <button
              type="button"
              data-variant="primary"
              onClick={stayOnSettings}
              data-testid="settings-unsaved-stay"
            >
              留下
            </button>
            <button
              type="button"
              data-variant="danger"
              onClick={confirmLeave}
              data-testid="settings-unsaved-leave"
            >
              离开
            </button>
          </div>
        }
      >
        <div className={dialogBody}>设置有未保存的更改，离开页面将丢失这些更改。</div>
      </Dialog>
    </div>
  )
}
