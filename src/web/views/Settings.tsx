import { css } from '@linaria/core'
import { useBlocker, useMatched } from '@native-router/react'
import type { Config } from '@shared/types/config.js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from 'haze-ui'
import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { Dialog } from '@/components/Dialog.js'
import { SyncedInput, SyncedSelect } from '@/components/SyncedControls.js'
import { AppearancePanel } from '@/components/settings/AppearancePanel.js'
import { CommaListInput } from '@/components/settings/CommaListInput.js'
import { CompactionPanel } from '@/components/settings/CompactionPanel.js'
import { FallbackPanel } from '@/components/settings/FallbackPanel.js'
import { GitPanel } from '@/components/settings/GitPanel.js'
import { JsonConfigEditor } from '@/components/settings/JsonConfigEditor.js'
import { MCPPanel } from '@/components/settings/MCPPanel.js'
import { ModelPanel } from '@/components/settings/ModelPanel.js'
import { ProviderPanel } from '@/components/settings/ProviderPanel.js'
import { SecurityPanel } from '@/components/settings/SecurityPanel.js'
import {
  RoleRoutingSection,
  SettingsSaveBar,
  SettingsToolbar,
} from '@/components/settings/SettingsChrome.js'
import {
  checkRow,
  field,
  fieldInput,
  hint,
  section,
  sectionTitle,
} from '@/components/settings/styles.js'
import { ToolsPanel } from '@/components/settings/ToolsPanel.js'
import { UsagePanel } from '@/components/settings/UsagePanel.js'
import { WebSearchPanel } from '@/components/settings/WebSearchPanel.js'
import { WorkflowsPanel } from '@/components/settings/WorkflowsPanel.js'
import { configAPI } from '@/services/config.js'
import { btnDanger } from '@/styles/tokens.js'
import { diffConfig, isPatchEmpty } from '@/utils/config-diff.js'

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

/** 离开确认弹窗正文。 */
const dialogBody = css`
  color: var(--haze-color-text-secondary);
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
  // P1-1：项目上下文来自路由（/projects/:projectId/settings）；
  // 无上下文时保持旧行为（服务启动目录项目 + 全局作用域）。
  const { params } = useMatched()
  const projectId = params.projectId
  const { data: resp, isLoading } = useQuery({
    queryKey: ['config', projectId ?? 'server'],
    queryFn: () => configAPI.get(projectId),
  })
  const config = resp?.config ?? null
  const warnings = resp?.warnings ?? []
  // P1-7：配置作用域（global 全局 / project 项目），保存时按此作用域落盘
  const [scope, setScope] = useState<'global' | 'project'>('project')
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

  // P1-7：安全类配置（token/authEnabled）需重启 serve 后生效，服务端在 PATCH 响应中标记。
  const [needsRestart, setNeedsRestart] = useState(false)

  // dirty 仅指「需手动保存的草稿」；外观面板即时生效、不进 draft，不影响此判定。
  const isDirty = draft !== null
  // 未保存导航防护（native-router useBlocker，模板口径）：覆盖全部离开通道——
  // 应用内导航、浏览器后退/前进（POP 自动回滚）、程序化 navigate。谓词按
  // ALLOW-list 语义：dirty ⇒ false（veto，弹确认）；clean ⇒ true（放行）。
  // 之前的 <a> 拦截 + popstate 回跳 + 程序化守卫注册表（utils/nav-guard）三通道已删除。
  const blocker = useBlocker(() => !isDirty)

  // 刷新/关闭页面前提示（useBlocker 只覆盖 SPA 内导航与后退/前进，
  // 浏览器关闭/刷新走原生 beforeunload 通道）。
  useEffect(() => {
    if (!isDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isDirty])

  const save = useMutation({
    mutationFn: (payload: { patch: Partial<Config>; scope: 'global' | 'project' }) =>
      configAPI.update(payload.patch, payload.scope, projectId),
    onMutate: () => setSaveFeedback({ kind: 'saving' }),
    onSuccess: (resp) => {
      qc.invalidateQueries({ queryKey: ['config'] })
      // 清除草稿：表单回退到已持久化状态（apiKey 输入不再回显明文，统一显示「已加密」），
      // isDirty 重置为 false，保存按钮禁用直到下一次编辑。
      setDraft(null)
      setNeedsRestart(resp?.needsRestart === true)
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

  /** 保存：diff 出相对加载时合并配置的变更（最小 patch，null=删除键），
   *  只把变更合并进目标作用域文件——不再全量落盘（P1-2 作用域污染修复）。 */
  const handleSave = () => {
    if (!draft) return
    const patch = diffConfig(
      config as unknown as Record<string, unknown>,
      draft as unknown as Record<string, unknown>,
    )
    if (isPatchEmpty(patch)) {
      setDraft(null)
      setSaveFeedback({ kind: 'ok' })
      setTimeout(() => setSaveFeedback((s) => (s.kind === 'ok' ? { kind: 'idle' } : s)), 2500)
      return
    }
    // P1-1 首跑作用域引导：全局与当前项目都还没有 provider、且本次保存引入了
    // provider 时，用户大概率以为在配置「本机 AI 服务」——默认落项目作用域会让
    // 配置在其他项目与 CLI（c0de chat）不可见。给一次「全局 or 项目」选择；
    // 项目作用域已有 provider（= 用户此前已选择过）时不再打扰。
    let effectiveScope: 'global' | 'project' = scope
    const globalProviders = Array.isArray(resp?.scopes?.global?.providers)
      ? (resp.scopes.global.providers as unknown[])
      : []
    const projectProviders = Array.isArray(resp?.scopes?.project?.providers)
      ? (resp.scopes.project.providers as unknown[])
      : []
    if (
      scope === 'project' &&
      (patch as Record<string, unknown>).providers !== undefined &&
      globalProviders.length === 0 &&
      projectProviders.length === 0 &&
      typeof window.confirm === 'function'
    ) {
      const useGlobal = window.confirm(
        '本机全局配置中还没有任何 AI 服务。\n\n' +
          '「确定」= 保存到全局配置（~/.c0de/config.json），所有项目与 c0de chat 均可直接使用（推荐）；\n' +
          '「取消」= 仅保存到当前项目配置（.c0de/config.json），其他项目与 CLI 不可见。',
      )
      if (useGlobal) {
        effectiveScope = 'global'
        setScope('global')
      }
    }
    save.mutate({ patch: patch as Partial<Config>, scope: effectiveScope })
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

  // ---- 标题生成模型 (roleRouting.smol) ----
  const updateRoleRouting = (field: 'provider' | 'model', value: string) => {
    setDraft((prev) => {
      const base = prev ?? config
      const routing = { ...(base.roleRouting ?? {}) }
      routing.smol = { ...(routing.smol ?? { provider: '', model: '' }), [field]: value }
      return { ...base, roleRouting: routing }
    })
  }
  const clearRoleRouting = () => {
    setDraft((prev) => {
      const base = prev ?? config
      const routing = { ...(base.roleRouting ?? {}) }
      delete routing.smol
      return { ...base, roleRouting: routing }
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

  /** 导出当前配置为 c0de-config.json（剔除明文 security.token 等敏感字段）。 */
  const exportConfig = () => {
    const text = viewMode === 'json' && !jsonError ? jsonText : JSON.stringify(merged, null, 2)
    // P3：security.token 为明文鉴权令牌，导出/分享配置文件不应携带。
    // apiKey 已由服务端加密（enc: 前缀），保留以便同机备份还原。
    const cleaned = JSON.parse(text) as Record<string, unknown>
    if (cleaned.security && typeof cleaned.security === 'object') {
      delete (cleaned.security as Record<string, unknown>).token
    }
    const blob = new Blob([JSON.stringify(cleaned, null, 2)], { type: 'application/json' })
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
  const stayOnSettings = () => blocker.reset()

  /** 离开确认弹窗：「离开」= 丢弃草稿并放行被 veto 的导航（proceed 重放）。 */
  const confirmLeave = () => {
    setDraft(null)
    if (viewMode === 'json') {
      setJsonText(JSON.stringify(config, null, 2))
      setJsonError(null)
    }
    blocker.proceed()
  }

  return (
    <div className={settingsScroll} data-testid="settings">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 16px',
          borderBottom: '1px solid var(--haze-color-border)',
          fontSize: 12,
        }}
      >
        <span style={{ color: 'var(--haze-color-text-secondary)' }}>配置作用域</span>
        <SyncedSelect
          value={scope}
          onValuesChange={(v) => {
            const next = v as 'global' | 'project'
            // P2-10：dirty 时切换作用域会把草稿整体落盘到新作用域——先确认，防止误写。
            if (
              next !== scope &&
              draft !== null &&
              !window.confirm('切换作用域将丢失未保存的更改。确定切换？')
            ) {
              return
            }
            if (next !== scope) {
              setDraft(null)
              setSaveFeedback({ kind: 'idle' })
            }
            setScope(next)
          }}
          data-testid="scope-select"
          style={{ fontSize: 12, padding: '3px 8px' }}
        >
          <option value="project">
            {projectId
              ? '项目配置（当前查看项目 .c0de/config.json）'
              : '项目配置（当前目录 .c0de/config.json）'}
          </option>
          <option value="global">全局配置（~/.c0de/config.json）</option>
        </SyncedSelect>
        {projectId && resp?.projectDir && (
          <span
            style={{
              color: 'var(--haze-color-text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '40%',
            }}
            title={resp.projectDir}
          >
            目标：{resp.projectDir}
          </span>
        )}
      </div>
      {warnings.length > 0 && (
        <div
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--haze-color-border)',
            background: 'color-mix(in srgb, var(--haze-color-warning) 10%, transparent)',
            fontSize: 12,
            color: 'var(--haze-color-text)',
          }}
          data-testid="config-warnings"
        >
          {warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}
      {resp?.gitWarning && (
        <div
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--haze-color-border)',
            background: 'color-mix(in srgb, var(--haze-color-warning) 10%, transparent)',
            fontSize: 12,
            color: 'var(--haze-color-warning)',
          }}
          data-testid="config-git-warning"
        >
          {resp.gitWarning}
        </div>
      )}
      <SettingsToolbar
        viewMode={viewMode}
        onSwitchGui={enterGuiMode}
        onSwitchJson={enterJsonMode}
        fileInputRef={fileInputRef}
        onImport={(e) => void onImportFile(e)}
        onExport={exportConfig}
      />

      {viewMode === 'json' ? (
        <JsonConfigEditor jsonText={jsonText} jsonError={jsonError} onChange={onJsonChange} />
      ) : (
        <div>
          <AppearancePanel />
          <ProviderPanel providers={merged.providers} onProvidersChange={updateProviders} />
          <ModelPanel
            providers={merged.providers}
            defaultProvider={merged.defaultProvider}
            defaultModel={merged.defaultModel}
            onChange={patchDraft}
          />
          <RoleRoutingSection
            routing={merged.roleRouting}
            onUpdate={updateRoleRouting}
            onClear={clearRoleRouting}
          />
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
              <span>成功率阈值</span>
              <SyncedInput
                className={fieldInput}
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={String(merged.toolMetrics.threshold)}
                onChange={(v) => updateSection('toolMetrics', { threshold: Number(v) })}
              />
            </label>
            <label className={field}>
              <span>最小样本数</span>
              <SyncedInput
                className={fieldInput}
                type="number"
                min={0}
                value={String(merged.toolMetrics.minSamples)}
                onChange={(v) => updateSection('toolMetrics', { minSamples: Number(v) })}
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
          <WorkflowsPanel projectId={projectId} />
          <div className={section}>
            <h2 className={sectionTitle}>多 Agent</h2>
            <label className={field}>
              <span>子 Agent 并发数</span>
              <SyncedInput
                className={fieldInput}
                type="number"
                min={1}
                value={String(merged.agents.subagentConcurrency)}
                onChange={(v) => updateSection('agents', { subagentConcurrency: Number(v) })}
              />
            </label>
          </div>
          <SecurityPanel
            security={merged.security}
            permission={merged.permission}
            securityScope={scope}
            onSecurityChange={(patch) => updateSection('security', patch)}
            onPermissionChange={(patch) => updateSection('permission', patch)}
          />
          <UsagePanel
            budget={merged.usage?.monthlyBudgetUsd ?? 0}
            budgetAction={merged.usage?.budgetAction ?? 'warn'}
            globalBudget={merged.usage?.globalMonthlyBudgetUsd ?? 0}
            tokenBudget={merged.usage?.monthlyTokenBudget ?? 0}
            globalTokenBudget={merged.usage?.globalMonthlyTokenBudget ?? 0}
            tokenBudgetAction={
              merged.usage?.tokenBudgetAction ?? merged.usage?.budgetAction ?? 'warn'
            }
            onBudgetChange={(v) => updateSection('usage', { monthlyBudgetUsd: v })}
            onBudgetActionChange={(v) => updateSection('usage', { budgetAction: v })}
            onGlobalBudgetChange={(v) => updateSection('usage', { globalMonthlyBudgetUsd: v })}
            onTokenBudgetChange={(v) => updateSection('usage', { monthlyTokenBudget: v })}
            onGlobalTokenBudgetChange={(v) =>
              updateSection('usage', { globalMonthlyTokenBudget: v })
            }
            onTokenBudgetActionChange={(v) => updateSection('usage', { tokenBudgetAction: v })}
            projectId={projectId}
          />
        </div>
      )}

      <SettingsSaveBar
        isDirty={isDirty}
        feedback={saveFeedback}
        onDiscard={discardChanges}
        onSave={handleSave}
      />

      {/* 安全类配置重启提示：token/authEnabled 由 authManager 启动时一次性读取 */}
      {needsRestart && (
        <div
          style={{
            padding: '8px 16px',
            borderTop: '1px solid var(--haze-color-border)',
            background: 'color-mix(in srgb, var(--haze-color-warning) 10%, transparent)',
            color: 'var(--haze-color-warning)',
            fontSize: 12,
          }}
          data-testid="settings-restart-hint"
        >
          安全配置已保存，但需重启 c0de serve 后生效：请在启动 c0de serve 的终端按 Ctrl+C
          停止后，重新运行 c0de serve。
        </div>
      )}

      {/* 未保存更改离开确认：弹窗遮罩阻断交互，「留下」恢复编辑，「离开」放行导航 */}
      <Dialog
        open={blocker.state != null}
        onClose={stayOnSettings}
        title="未保存的更改"
        width="min(420px, 92vw)"
        testId="settings-unsaved-dialog"
        footer={
          <div className={dialogActions}>
            <Button onClick={stayOnSettings} data-testid="settings-unsaved-stay" variant="solid">
              留下
            </Button>
            <Button
              className={btnDanger}
              variant="outline"
              onClick={confirmLeave}
              data-testid="settings-unsaved-leave"
            >
              离开
            </Button>
          </div>
        }
      >
        <div className={dialogBody}>设置有未保存的更改，离开页面将丢失这些更改。</div>
      </Dialog>
    </div>
  )
}
