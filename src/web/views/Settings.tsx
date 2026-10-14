import { css } from '@linaria/core'
import { useBlocker, useMatched, useSearchParams } from '@native-router/react'
import type { Config } from '@shared/types/config.js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, ConfirmDialog } from 'haze-ui'
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
import { SettingsToc } from '@/components/settings/SettingsToc.js'
import { onTocReady, scrollSettingsSectionIntoView } from '@/components/settings/sectionScroll.js'
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
import {
  fillTemplateWithUnsets,
  normalizeConfigForForm,
  validateConfigShape,
} from '@/utils/config-shape.js'
import { parseBoundedNumber } from '@/utils/format.js'

/** 全局配置作用域的写入路径（与作用域下拉文案同一口径）。 */
const GLOBAL_CONFIG_PATH = '~/.c0de/config.json'

/** 加载中占位。 */
const loadingWrap = css`
  padding: 24px;
`

/**
 * 读失败态：标题 / 原因 / 动作三段式（与 KanbanView 同一套表达）。
 *
 * 设置页是配 AI 服务、token、权限的唯一入口，落到「永远加载中」等于
 * 整个应用不可配置；因此这里必须把原因说清楚，并给一个不丢页面的重试。
 */
const loadError = css`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 24px;
`

const loadErrorTitle = css`
  color: var(--haze-color-danger);
  font-size: 14px;
  font-weight: 600;
`

const loadErrorDetail = css`
  color: var(--haze-color-text-secondary);
  font-size: 13px;
  /* 后端 message 可能是长路径/长提示，窄屏下必须能断行 */
  overflow-wrap: anywhere;
`

const loadErrorActions = css`
  margin-top: 4px;
`

/**
 * Settings 根容器：flex 列，按内容撑高并至少占满编辑区。
 *
 * 刻意不用 overflow:auto——它会把自己变成 sticky 的「最近滚动祖先」，而本容器
 * 从不滚动（实测 scrollHeight === clientHeight === 3351，滚动发生在
 * .haze-Workbench__editor）。零滚动范围的 scrollport 让 sticky 完全失效：
 * 工具条（top:0）与吸底保存条（bottom:0）都钉在文档流原位，跟随整页一起滚走。
 * 后果是保存条在 4002px 长的表单里只有最后 45px 能看见
 * （scrollTop=0 时 top=3378；滚到底 top=855），改完配置看不到「保存」在哪，
 * 也没有任何常驻入口。改为 overflow:visible 后，sticky 正确回落到 <main> 这个
 * 真正的滚动容器，保存条恒钉在视口底部。
 *
 * min-height:100% 而非 height:100%：内容短于视口时靠 SaveBar 的 margin-top:auto
 * 把保存条压到底部；内容变长时容器按内容撑开（height:100% + flex 子项默认
 * shrink:1 会把表单控件压扁）。
 */
const settingsScroll = css`
  display: flex;
  flex-direction: column;
  min-height: 100%;
`

/**
 * 配置作用域工具条：标签 + 下拉单行排布。
 *
 * 标签禁止收缩（flex 子项默认 shrink:1）：下拉随选项文案自适应宽度，
 * 会把相邻标签挤到「每行 1–2 字」竖排（实测 5 字「配置作用域」在
 * 57px 宽的盒子里折成 2 行、36px 高）。与 settings/styles.field 同口径。
 */
const scopeBar = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 12px;
`

const scopeLabel = css`
  flex-shrink: 0;
  white-space: nowrap;
  color: var(--haze-color-text-secondary);
`

/** 「目标」写入路径标注：必须与当前作用域一致，故单独成类供 global/project 两分支共用。 */
const scopeTarget = css`
  flex-shrink: 0;
  color: var(--haze-color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
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
  const [searchParams] = useSearchParams()
  const projectId = params.projectId
  const {
    data: resp,
    isLoading,
    isError,
    error: configError,
    refetch: refetchConfig,
  } = useQuery({
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
  // JSON 视图内容的**结构**问题（语法合法、但与表单所需的 Config 形状不符）。
  // 与语法错误分开存放：两者都禁止保存与切回表单，但原因文案不同。
  const [jsonShapeError, setJsonShapeError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 保存反馈：idle/saving/ok/err，ok 在 2.5s 后自动清除。
  const [saveFeedback, setSaveFeedback] = useState<
    { kind: 'idle' } | { kind: 'saving' } | { kind: 'ok' } | { kind: 'err'; msg: string }
  >({ kind: 'idle' })

  // P1-7：安全类配置（token/authEnabled）需重启 serve 后生效，服务端在 PATCH 响应中标记。
  const [needsRestart, setNeedsRestart] = useState(false)

  // 挂在吸底保存条上（此前是文档最末端的独立条，3500px+ 的表单里永远看不见）。
  const RESTART_NOTICE = needsRestart
    ? '安全配置已保存但未生效：需重启 c0de serve，请在启动它的终端按 Ctrl+C 后重新运行。'
    : null

  // P2-10：dirty 时切换作用域会丢弃草稿——ConfirmDialog 二次确认，
  // 确认前暂存目标作用域（SyncedSelect 受控，选中项会弹回当前 scope）。
  const [pendingScope, setPendingScope] = useState<'global' | 'project' | null>(null)

  // dirty 时导入配置会整块覆盖草稿——同样是二次确认，确认前暂存待导入的配置。
  // 此前导入无条件 `setDraft(导入值)`：用户在表单里改了一屏字段、吸底条写着
  // 「● 未保存更改」，点一次「⬆ 导入」选个文件，所有修改被静默替换（保存条随即
  // 回到干净态，看不出发生过什么），而本页影响面更小的动作（切换作用域、离开页面、
  // 删 MCP 行）都有二审——覆盖面最大的一次覆盖反而是唯一没有确认的。
  const [pendingImport, setPendingImport] = useState<Partial<Config> | null>(null)

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
      // needsRestart 是**本次 patch 各自**的信号（服务端只在本次写入 security/
      // update/plugins 且作用域为 global/服务启动目录时返回 true）。覆盖式置位会
      // 让「鉴权改动尚未生效」的唯一警告被下一次无关保存（如改默认模型，返回
      // false）静默抹掉，用户据此认定配置已加固。故只升不降：重启后页面重载，
      // state 自然复位。
      setNeedsRestart((prev) => prev || resp?.needsRestart === true)
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

  // 深链定位：顶栏成本徽标承诺「点击前往用量与成本」，此前只跳到设置页顶部——
  // 实测「用量与成本」在文档 y=3107 而滚动容器停在 0，用户看到的是「外观」，
  // 与徽标 tooltip 的承诺不符。?section=<id> 落地后滚到该分区。
  //
  // 必须挂在所有 early return（isLoading / isError）之前：Hooks 数量须跨渲染
  // 恒定，否则「重试成功后从失败态恢复」这类先失败再成功的路径直接崩。
  //
  // 落点必须让开顶部两条 sticky（工具条 + 分区目录行）。原先写死
  // `offsetTop - 16`，目录行出现后标题会停在两条 sticky 底下被完全遮住：
  // 实测深链 ?section=section-5-上下文压缩 时标题落在 y=61，而目录行下沿在
  // 141——「点了徽标/链接却什么都没变」。offsetTop 还相对各自 offsetParent
  // （.haze-Workbench__workbench），与容器 scrollTop 并非同一坐标系。
  // 口径统一到 scrollSettingsSectionIntoView，与点目录跳转完全一致。
  //
  // 还要再等目录行就绪：目录行是 SettingsToc 扫描完 h2 才渲染的，而本
  // effect 与那次扫描同批跑，那时目录行尚未入 DOM，实测高度为 0，落点会
  // 再少让 45px（标题又回到目录行底下）。订阅 onTocReady 后重算一次。
  //
  // 配置未就绪时 UsagePanel 尚未挂载，getElementById 落空，本 effect 会在
  // resp 到达后由依赖重跑。
  //
  // 依赖必须是**锚点字符串**而不是 searchParams 实例：useSearchParams 每次渲染
  // 都 `new URLSearchParams(useSyncExternalStore(...))`（@native-router/react
  // dist/use-search-params.js），对象身份逐渲染不同。把它放进依赖等于本 effect
  // 每次渲染都重跑，而 jump → scrollSettingsSectionIntoView 无条件
  // `scrollTop += delta`（sectionScroll.ts）：只要 URL 里留着 ?section=，用户滚到
  // 别的分区一敲字（setDraft 逐字符重渲染，保存反馈定时器、config refetch 同理）
  // 就被拽回锚点分区，输入框逐字跳出视口——「锚点之外的字段根本没法编辑」。
  // 顶栏成本徽标正是带 ?section=usage 跳进来的（TopBar MonthCostBadge），URL
  // 上的参数会留到用户离开该页为止。
  const sectionAnchor = searchParams.get('section')
  // biome-ignore lint/correctness/useExhaustiveDependencies: resp/viewMode 只作「面板已挂载」的触发信号，effect 内不读
  useEffect(() => {
    if (!sectionAnchor) return
    const jump = () => {
      const target = document.getElementById(sectionAnchor)
      if (target) scrollSettingsSectionIntoView(target)
    }
    jump()
    return onTocReady(jump)
  }, [sectionAnchor, resp, viewMode])

  if (isLoading) return <div className={loadingWrap}>加载中…</div>
  // 读失败必须与「还在加载」区分。此前 `isLoading || !config` 把两者并成一条：
  // 请求 500 时 isLoading 已为 false 而 config 恒为 null（resp 为 undefined），
  // 于是设置页永久停在「加载中…」——实测注入 /api/config 500、retry:2 耗尽后
  // 40s+ 无任何错误、无重试，用户会一直等一个永远不会到来的表单。
  // 这比回收站/看板的「误报为空」更糟：它连一个错误的结论都不给。
  if (isError) {
    // APIError 是真正的 Error（services/api.ts 的 ApiErrorImpl），message 即后端文案；
    // 结构化取优先、instanceof 兜底。
    const message =
      (configError as { message?: string } | null)?.message ??
      (configError instanceof Error ? configError.message : null)
    return (
      <div className={loadError} data-testid="settings-load-error" role="alert">
        <div className={loadErrorTitle}>设置加载失败</div>
        <div className={loadErrorDetail}>{message ?? '无法读取配置文件。'}</div>
        <div className={loadErrorActions}>
          <Button variant="outline" onClick={() => refetchConfig()} data-testid="settings-retry">
            重试
          </Button>
        </div>
      </div>
    )
  }
  // 请求成功但没有 config 体（契约破损）：给出可行动的说明，而不是「加载中…」。
  if (!config) {
    return (
      <div className={loadError} data-testid="settings-load-error" role="alert">
        <div className={loadErrorTitle}>设置加载失败</div>
        <div className={loadErrorDetail}>服务返回了空的配置内容，请确认工作区配置后重试。</div>
        <div className={loadErrorActions}>
          <Button variant="outline" onClick={() => refetchConfig()} data-testid="settings-retry">
            重试
          </Button>
        </div>
      </div>
    )
  }

  const merged = { ...config, ...draft }

  /** 保存：diff 出相对加载时合并配置的变更（最小 patch，null=删除键），
   *  只把变更合并进目标作用域文件——不再全量落盘（P1-2 作用域污染修复）。 */
  const handleSave = () => {
    if (!draft) return
    // JSON 视图语法错误时 draft 停在最后一次合法解析上：直接保存会落盘一版
    // 与编辑器内容不符的旧配置，并在保存条上回显「✓ 已保存」，屏幕上的改动
    // 静默消失。结构错误（语法合法但形状不符）同样不能存：服务端会照抄落盘，
    // 之后每次打开设置页都因同一份坏形状崩进 ErrorBoundary。
    // 按钮已禁用，这里再兜一层，避免键盘/程序化调用绕过。
    if (jsonError || jsonShapeError) {
      setSaveFeedback({
        kind: 'err',
        msg: jsonError
          ? 'JSON 语法错误：已阻止保存，请先修复语法'
          : '配置结构错误：已阻止保存，请先修复结构（原因见编辑器下方）',
      })
      return
    }
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
      // 显式置 undefined（而不是 delete 这个键）：JSON↔表单往返靠「显式清除」
      // 与「文本里没写」区分意图（见 fillTemplateWithUnsets）。delete 之后该键从
      // 草稿里彻底消失，切回表单时会被当成「补全模板里缺的键」按已落盘值补回来，
      // 用户清除掉的 smol 自己回来了。与 GitPanel「取消勾选」同口径。
      // （Config['roleRouting'] 的索引签名声明每个角色都是完整对象，不表示「键在但
      //  被清除」；运行时 smol 缺席/为 undefined 都不渲染，消费方本就按可选处理。）
      ;(routing as { smol?: { provider: string; model: string } }).smol = undefined
      return { ...base, roleRouting: routing }
    })
  }

  // ---- JSON 模式 / 导入导出 ----

  /** 进入 JSON 模式：以当前合并配置序列化为初始文本。 */
  const enterJsonMode = () => {
    setJsonText(JSON.stringify(merged, null, 2))
    setJsonError(null)
    setJsonShapeError(null)
    setViewMode('json')
  }

  /** JSON 文本变更：实时解析，合法则同步 draft，非法仅提示（语法/结构分开报）。 */
  const onJsonChange = (text: string) => {
    setJsonText(text)
    try {
      const parsed = JSON.parse(text) as Partial<Config>
      setJsonError(null)
      setDraft(parsed)
      // 结构校验与语法校验同时做：语法合法但形状不对（如 tools 写成字符串、
      // plugins.enabled 缺失）的内容一旦铺进表单就是整页崩溃（面板按 Config
      // 类型假定字段形状），也会把坏形状落盘成永久崩溃源。此处先拦下来。
      setJsonShapeError(validateConfigShape(parsed, config))
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : 'JSON 解析错误')
    }
  }

  /** 切回 GUI：JSON 非法（语法或结构）时阻止（避免丢失未保存的编辑）。
   *  合法时把内容归一化成完整 Config——表单需要完整形状，直接下发原始对象
   *  会让面板读到 undefined（CommaInput 的 value.join、数字字段的算术）。
   *
   *  补全模板不能直接用已落盘的 config：用户在表单里取消勾选「一键提交使用独立
   *  模型」（commitModel: undefined）后，JSON.stringify 会把值为 undefined 的键
   *  整条丢掉，JSON 文本里既没有该键也没有 null。用 config 当模板补全，正好把这个
   *  「用户刚做的删除」当成「文本里缺的键」按旧值补回来——复选框自己变回勾选，
   *  草稿与 config 又逐键相同，保存 diff 出空 patch 直接回显「✓ 已保存」，磁盘上
   *  什么都没变。故用 fillTemplateWithUnsets(config, draft)：草稿里显式清除的键
   *  保持清除，其余缺失键仍按当前配置补全（表单不读 undefined）。
   *  导入路径（见 importConfig）继续以 config 为模板：导入的是完整配置文件、没有
   *  草稿可参照，「缺失键按当前值补全」在那里才是对的。 */
  const enterGuiMode = () => {
    if (viewMode !== 'json') return
    if (jsonError) return
    const normalized = normalizeConfigForForm(
      JSON.parse(jsonText) as unknown,
      fillTemplateWithUnsets(config, draft ?? {}),
    )
    if (!normalized.ok) {
      setJsonShapeError(normalized.message)
      return
    }
    setDraft(normalized.config)
    setJsonText(JSON.stringify(normalized.config, null, 2))
    setJsonShapeError(null)
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

  /** 应用导入结果：整份替换草稿并切回表单（形状已校验）。 */
  const applyImport = (next: Partial<Config>) => {
    setDraft(next)
    setJsonText(JSON.stringify(next, null, 2))
    setJsonError(null)
    setJsonShapeError(null)
    setViewMode('gui')
  }

  /** 从文件导入配置。 */
  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as unknown
      // 形状校验与语法校验是两件事：此前只 JSON.parse 就把对象铺进表单，
      // 一份语法合法但结构不对的配置（`{"plugins": {}}`、`{"tools":
      // {"disabled": ["bash"]}}`）会让整页崩进 ErrorBoundary，未保存的编辑
      // 一并丢失，用户也看不出是导入的文件有问题。这里按当前已解析配置的
      // 形状校验并补全缺失字段（与服务端读取时的合并口径一致），不符则原地
      // 报错、把原文留在 JSON 编辑器里供修正。
      const normalized = normalizeConfigForForm(parsed, config)
      if (!normalized.ok) {
        setJsonShapeError(normalized.message)
        setJsonError(null)
        setViewMode('json')
        setJsonText(text)
        return
      }
      // 未保存的修改必须先经确认：导入是整份替换（且随后可一键落盘），
      // 直接覆盖等于一次点击丢掉用户在表单/JSON 里打好的全部内容。
      // 待导入配置暂存到弹窗，确认后才应用。
      if (draft !== null) {
        setPendingImport(normalized.config)
        return
      }
      applyImport(normalized.config)
    } catch (err) {
      setJsonError(`导入失败：${err instanceof Error ? err.message : '未知错误'}`)
      setJsonShapeError(null)
      setViewMode('json')
      // 把读取到的原始文本放进编辑器方便定位问题
      try {
        setJsonText(await file.text())
      } catch {
        /* ignore */
      }
    } finally {
      e.target.value = '' // 允许重复导入同一文件（含被确认弹窗拦下的那次）
    }
  }

  /** 放弃未保存的更改：草稿清空回退到已持久化配置（JSON 模式同步重置编辑器）。 */
  const discardChanges = () => {
    setDraft(null)
    if (viewMode === 'json') {
      setJsonText(JSON.stringify(config, null, 2))
      setJsonError(null)
      setJsonShapeError(null)
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
      setJsonShapeError(null)
    }
    blocker.proceed()
  }

  return (
    <div className={settingsScroll} data-testid="settings">
      <div className={scopeBar}>
        <span className={scopeLabel}>配置作用域</span>
        <SyncedSelect
          aria-label="配置作用域"
          value={scope}
          onValuesChange={(v) => {
            const next = v as 'global' | 'project'
            // P2-10：dirty 时切换作用域会把草稿整体落盘到新作用域——先确认，防止误写。
            if (next !== scope && draft !== null) {
              setPendingScope(next)
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
          <option value="global">全局配置（{GLOBAL_CONFIG_PATH}）</option>
        </SyncedSelect>
        {/* 写入目标必须与当前作用域一致：此前无论选哪个作用域都渲染项目目录，
            切到「全局配置（~/.c0de/config.json）」后仍标「目标：<项目目录>」，
            而保存其实写进全局配置——用户据此以为改的是项目文件，把项目专属值
            （路径、模型名）提升成全机默认，其他项目与 c0de chat 一起被改。 */}
        {scope === 'global' ? (
          <span className={scopeTarget} title={GLOBAL_CONFIG_PATH}>
            目标：{GLOBAL_CONFIG_PATH}
          </span>
        ) : projectId && resp?.projectDir ? (
          <span className={scopeTarget} title={resp.projectDir}>
            目标：{resp.projectDir}
          </span>
        ) : null}
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
        guiDisabledReason={
          jsonError
            ? 'JSON 语法错误：请先修复后再切回表单'
            : jsonShapeError
              ? `配置结构错误：${jsonShapeError}`
              : null
        }
        fileInputRef={fileInputRef}
        onImport={(e) => void onImportFile(e)}
        onExport={exportConfig}
      />

      {viewMode === 'json' ? (
        <JsonConfigEditor
          jsonText={jsonText}
          jsonError={jsonError ?? (jsonShapeError ? `配置结构错误：${jsonShapeError}` : null)}
          onChange={onJsonChange}
        />
      ) : (
        <div data-testid="settings-form">
          <SettingsToc />
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
                onChange={(v) =>
                  updateSection('toolMetrics', {
                    threshold: parseBoundedNumber(v, merged.toolMetrics.threshold, {
                      min: 0,
                      max: 1,
                    }),
                  })
                }
              />
            </label>
            <label className={field}>
              <span>最小样本数</span>
              <SyncedInput
                className={fieldInput}
                type="number"
                min={0}
                value={String(merged.toolMetrics.minSamples)}
                onChange={(v) =>
                  updateSection('toolMetrics', {
                    minSamples: parseBoundedNumber(v, merged.toolMetrics.minSamples, { min: 0 }),
                  })
                }
              />
            </label>
          </div>
          <div className={section}>
            <h2 className={sectionTitle}>插件</h2>
            <CommaListInput
              ariaLabel="已启用的插件名称"
              value={merged.plugins.enabled}
              onCommit={(items) => updateSection('plugins', { enabled: items })}
              placeholder="plugin-a, plugin-b"
            />
            <div className={hint}>用逗号分隔已启用的插件名称。</div>
          </div>
          <div className={section}>
            <h2 className={sectionTitle}>斜杠命令</h2>
            <CommaListInput
              ariaLabel="已启用的斜杠命令"
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
                onChange={(v) =>
                  updateSection('agents', {
                    subagentConcurrency: parseBoundedNumber(v, merged.agents.subagentConcurrency, {
                      min: 1,
                    }),
                  })
                }
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
        blockedReason={
          jsonError
            ? 'JSON 语法错误：请先修复编辑器中标红的问题，当前内容无法保存'
            : jsonShapeError
              ? `配置结构错误：${jsonShapeError}，当前内容无法保存`
              : null
        }
        restartNotice={RESTART_NOTICE}
        onDiscard={discardChanges}
        onSave={handleSave}
      />

      {/* P2-10：dirty 时切换作用域的二次确认（替代 window.confirm：
       * 原生框无样式、阻塞事件循环，且文案无法强调「丢弃」后果。
       * 条件渲染挂载：react-use-control 的 open 布尔值仅是初始值，
       * prop 变化不同步内部状态——必须以挂载/卸载驱动显隐）。 */}
      {pendingScope !== null && (
        <ConfirmDialog
          open
          onClose={() => setPendingScope(null)}
          onConfirm={() => {
            setDraft(null)
            setSaveFeedback({ kind: 'idle' })
            setScope(pendingScope)
            setPendingScope(null)
          }}
          title="切换配置作用域"
          confirmText="切换并丢弃更改"
          cancelText="取消"
        >
          当前有未保存的更改，切换作用域将丢弃这些更改。确定切换？
        </ConfirmDialog>
      )}

      {/* 未保存更改时导入配置：同一口径的二次确认（挂载驱动显隐）。确认才
       * 应用导入值；取消保持当前草稿原样，什么都没发生过。 */}
      {pendingImport !== null && (
        <ConfirmDialog
          open
          onClose={() => setPendingImport(null)}
          onConfirm={() => {
            applyImport(pendingImport)
            setPendingImport(null)
          }}
          title="导入配置"
          confirmText="导入并覆盖"
          cancelText="取消"
        >
          当前有未保存的更改，导入将丢弃这些更改并用文件内容覆盖。确定导入？
        </ConfirmDialog>
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
