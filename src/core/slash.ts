import { resolve } from 'node:path'
import type { DB } from '../db/client.js'
import { createSession, getSession } from '../session/session.js'

import { createAgent } from './agent.js'
import type { SlashCommand } from './types.js'
import {
  BUILTIN_WORKFLOWS,
  createWorkflowRegistry,
  discoverWorkflows,
  executeWorkflow,
  reloadRegistry,
  saveWorkflow,
} from './workflows/index.js'

function parseSlashInput(input: string): { name: string; args: string } | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const spaceIdx = trimmed.indexOf(' ')
  if (spaceIdx === -1) {
    return { name: trimmed.slice(1), args: '' }
  }
  return { name: trimmed.slice(1, spaceIdx), args: trimmed.slice(spaceIdx + 1).trim() }
}

/** 校验跨会话操作的归属：目标会话必须存在；当前会话与目标均挂项目时须同项目，
 *  防 Web 端误输/被注入 id 清空或分支其他项目的会话。CLI 无当前会话上下文
 *  （sessionId 缺省）时放行——终端单用户显式操作。 */
async function assertSameProjectSession(
  db: DB,
  currentId: string | undefined,
  targetId: string,
): Promise<void> {
  const target = await getSession(db, targetId)
  if (!target) throw new Error(`目标会话不存在：${targetId}`)
  if (!currentId || currentId === targetId) return
  const current = await getSession(db, currentId)
  const currentProject = current?.projectId ?? null
  const targetProject = target.projectId ?? null
  if (currentProject !== null && targetProject !== null && currentProject !== targetProject) {
    throw new Error(`会话 ${targetId} 属于其他项目，不能从当前会话操作`)
  }
}

type SlashRegistry = {
  has: (name: string) => boolean
  get: (name: string) => SlashCommand | undefined
  list: () => SlashCommand[]
  register: (cmd: SlashCommand) => void
}

function createSlashRegistry(): SlashRegistry {
  const commands = new Map<string, SlashCommand>()
  for (const cmd of builtinCommands) {
    commands.set(cmd.name, cmd)
  }
  return {
    has: (name) => commands.has(name),
    get: (name) => commands.get(name),
    list: () => Array.from(commands.values()),
    register: (cmd) => commands.set(cmd.name, cmd),
  }
}

/**
 * P0-2：统一斜杠命令启用判定（Web chat / CLI chat / 命令列表 / /help 共用）。
 * 语义（fail-closed，与 tools.enabled 对齐）：
 *  - enabled 含 '*'（通配）→ 全部启用。
 *  - enabled 为显式名单 → 仅名单内启用（名称兼容带/不带前缀斜杠）。
 *  - enabled 为空数组/缺失 → 全部禁用（旧版含义「空=全部启用」，升级告警见
 *    collectConfigMigrationWarnings——两处同形键不再语义相反）。
 * `enabled` 已含 '/' 前缀或裸名均可。
 */
export function isSlashCommandEnabled(enabled: string[] | undefined, name: string): boolean {
  const list = enabled ?? []
  if (list.length === 0) return false
  if (list.includes('*')) return true
  const norm = name.startsWith('/') ? name.slice(1) : name
  return list.some((n) => (n.startsWith('/') ? n.slice(1) : n) === norm)
}

const helpCommand: SlashCommand = {
  name: 'help',
  description: '列出可用斜杠命令',
  execute: async (_args, ctx) => {
    // 从 registry 动态生成，避免静态文案随命令增删漂移；
    // 尊重 slashCommands.enabled 过滤（含 ['*'] = 全部启用；空 = 全部禁用）。
    const enabledList = ctx.config.slashCommands?.enabled
    const commands = createSlashRegistry()
      .list()
      .filter((c) => isSlashCommandEnabled(enabledList, c.name))
    const width = Math.max(...commands.map((c) => `/${c.name}`.length))
    const lines = ['可用命令：']
    for (const cmd of commands) {
      const hint = cmd.argsHint ? ` ${cmd.argsHint}` : ''
      const pad = ' '.repeat(Math.max(1, width - `/${cmd.name}`.length))
      lines.push(`  /${cmd.name}${pad}${hint}  ${cmd.description}`)
    }
    return { _tag: 'text', text: lines.join('\n') }
  },
}

const compactCommand: SlashCommand = {
  name: 'compact',
  description: '手动触发上下文压缩',
  execute: async () => {
    // 仅声明意图：真正的压缩由消费方（loop.compactContext / chat 路由）执行，
    // 复用 createSummarizer + runCompaction，且不把 /compact 当作 user 消息发给 LLM。
    return { _tag: 'compact' }
  },
}

const modelCommand: SlashCommand = {
  name: 'model',
  description: '查看当前会话使用的模型',
  argsHint: '',
  execute: async (_args, ctx) => {
    // P2：诚实化——此前返回「Model set to X」但什么都不生效，后改为引导文案。
    // 现在提供真实信息：优先读本会话活跃段的 provider/model（若存在），
    // 否则回退默认配置。会话模型切换由底部 ModelSelector 完成（Web）；
    // CLI 按渠道给出可操作指引（P3：此前 CLI 输出指向 Web-only 控件，是死路）。
    const model = async (): Promise<string | null> => {
      if (!ctx.sessionId) return null
      try {
        const { getLLMSegments } = await import('../session/session.js')
        const segs = await getLLMSegments(ctx.deps.db, ctx.sessionId)
        const last = segs[segs.length - 1]
        if (last) return `${last.model}（provider: ${last.provider}）`
      } catch {
        // 段查询失败回退默认值展示
      }
      return null
    }
    const sessionModel = await model()
    if (ctx.channel === 'cli') {
      return {
        _tag: 'text',
        text:
          `${sessionModel ? `当前会话模型：${sessionModel}` : `默认模型：${ctx.config.defaultModel}（provider: ${ctx.config.defaultProvider}）`}\n` +
          'CLI 模式不支持会话内切换模型：新会话用 c0de chat --model <model>，' +
          '或 c0de config set defaultModel <model> 修改默认模型。',
      }
    }
    return {
      _tag: 'text',
      text:
        `${sessionModel ? `当前会话模型：${sessionModel}` : `默认模型：${ctx.config.defaultModel}（provider: ${ctx.config.defaultProvider}）`}\n` +
        '切换模型请使用聊天页底部的模型选择器。',
    }
  },
}

const clearCommand: SlashCommand = {
  name: 'clear',
  description: '清空会话消息（先归档原始内容）',
  argsHint: '[session-id] [--yes]',
  execute: async (args, ctx) => {
    const parts = args.split(/\s+/).filter(Boolean)
    const yes = parts.includes('--yes')
    const sessionId = parts.find((p) => p !== '--yes') ?? ctx.sessionId
    if (!sessionId) {
      return { _tag: 'error', message: 'Usage: /clear [session-id] --yes（当前会话可省略 id）' }
    }
    try {
      await assertSameProjectSession(ctx.deps.db, ctx.sessionId, sessionId)
    } catch (error) {
      return { _tag: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    if (!yes) {
      return {
        _tag: 'error',
        message:
          '清空消息不可逆。原始消息将归档到「会话归档」面板（会话页顶部「归档」按钮可查看/搜索），确认请执行 /clear --yes（或 /clear <session-id> --yes）。',
      }
    }
    const { getEntries, deleteEntriesByIds } = await import('../session/message.js')
    const entries = await getEntries(ctx.deps.db, sessionId)
    const ids = entries.map((e) => ('id' in e ? e.id : '')).filter(Boolean)
    if (ids.length > 0) {
      // 归档原始内容（与 shake 同机制），删除才有后悔路径
      const { archiveOriginalEntries } = await import('../session/archive.js')
      const { generateId } = await import('../shared/index.js')
      await archiveOriginalEntries(
        ctx.deps.db,
        sessionId,
        entries,
        'clear',
        `Cleared ${ids.length} entries`,
        generateId(),
      )
      await deleteEntriesByIds(ctx.deps.db, ids)
    }
    return {
      _tag: 'success',
      message: `已清空 ${ids.length} 条消息（原内容已归档，可在会话页「归档」面板查看；历史 token/成本仍计入本会话用量统计）`,
    }
  },
}

const forkCommand: SlashCommand = {
  name: 'fork',
  description: '从指定消息处分支会话',
  argsHint: '[session-id] [message-index]',
  execute: async (args, ctx) => {
    const parts = args.split(/\s+/).filter(Boolean)
    // 默认当前会话；第一个非纯数字参数视为 session id 覆盖（fork 其他会话）。
    let sessionId = ctx.sessionId
    let messageIndex: number | undefined
    for (const p of parts) {
      if (/^\d+$/.test(p)) {
        messageIndex = Number.parseInt(p, 10)
      } else {
        sessionId = p
      }
    }
    if (!sessionId) {
      return {
        _tag: 'error',
        message: 'Usage: /fork [session-id] [message-index]（当前会话可省略 id）',
      }
    }
    try {
      await assertSameProjectSession(ctx.deps.db, ctx.sessionId, sessionId)
    } catch (error) {
      return { _tag: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    // 未指定 index → 默认最新一条消息处分支（与 web fork API 语义一致，不再是 index 0）
    if (messageIndex === undefined) {
      const { getMessages } = await import('../session/message.js')
      const messages = await getMessages(ctx.deps.db, sessionId)
      if (messages.length === 0) {
        return { _tag: 'error', message: 'EMPTY_SESSION: 空会话无法分支' }
      }
      messageIndex = messages.length - 1
    }
    const { forkSession } = await import('../session/branch.js')
    try {
      const forked = await forkSession(ctx.deps.db, sessionId, messageIndex)
      return { _tag: 'success', message: `已分支到新会话：${forked.id}` }
    } catch (error) {
      return {
        _tag: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  },
}

const configCommand: SlashCommand = {
  name: 'config',
  description: '查看或设置配置（支持点路径）',
  argsHint: '[key] [value]',
  execute: async (args, ctx) => {
    const { getByPath, setPathPatch, coerce } = await import('./config-path.js')
    // 展示前脱敏：apiKey/token 等敏感字段绝不原样出现在聊天里（P0 密钥暴露）。
    const { redactSecrets } = await import('./redact.js')
    if (!args) {
      return {
        _tag: 'text',
        text: `（合并视图：global + project 作用域；修改请用 /config <key> <value>，写入 project 作用域）\n${JSON.stringify(redactSecrets(ctx.config), null, 2)}`,
      }
    }
    const parts = args.split(/\s+/)
    const key = parts[0] ?? ''
    if (parts.length === 1) {
      try {
        // 用点路径末段作为键名参与脱敏判定：/config security.token 等单键读取同样掩码。
        const leaf = key.split('.').pop()
        const value = redactSecrets(getByPath(ctx.config, key), leaf)
        return {
          _tag: 'text',
          text: `${key}: ${JSON.stringify(value)}（合并视图：global + project 作用域）`,
        }
      } catch (error) {
        return { _tag: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    }
    // 点路径写值：与 CLI config set 同语义（project 作用域最小落盘，null=unset）
    const { applyScopedPatch, loadConfigScopes, saveConfigScoped } = await import('./config.js')
    // 作用域收敛：security 是服务端全局参数，项目作用域写入会被加载时剥离（不生效），
    // 直接拒绝并给出正解路径（与 CLI config set --global / Web PATCH /api/config 同语义）。
    if (key.split('.')[0] === 'security') {
      return {
        _tag: 'error',
        message:
          'security 是服务端全局参数，仅在全局作用域生效。请在全局配置（~/.c0de/config.json）中设置，或用 c0de config set --global 写入。',
      }
    }
    const scopes = loadConfigScopes(ctx.cwd)
    const value = coerce(parts.slice(1).join(' '))
    const next = applyScopedPatch(scopes.project ?? {}, setPathPatch(key, value))
    await saveConfigScoped('project', ctx.cwd, next)
    return {
      _tag: 'success',
      message: `${value === null ? '已取消设置' : '已设置'} ${key} (scope: project)`,
    }
  },
}

const workflowCommand: SlashCommand = {
  name: 'workflow',
  description: '管理并运行工作流',
  argsHint: '[list|run|show|create|edit] [name] [args]',
  subcommands: [
    { name: 'list', description: 'List available workflows' },
    { name: 'run', description: 'Run a workflow', usage: '<name> [args]' },
    { name: 'show', description: 'Show workflow source', usage: '<name>' },
    { name: 'create', description: 'Create a workflow from file', usage: '<name> --file <path>' },
    { name: 'edit', description: 'Edit workflow source', usage: '<name>' },
  ],
  execute: async (args, ctx) => {
    const parts = args.split(/\s+/).filter(Boolean)
    const subcommand = parts[0] ?? 'list'

    let registry = ctx.workflowRegistry
    if (!registry) {
      // 回退：创建仅含内置的注册表
      registry = createWorkflowRegistry()
      for (const wf of BUILTIN_WORKFLOWS) {
        registry.register(wf)
      }
    }

    // 项目级工作流：从 agent cwd（= project worktree）动态发现。
    // registry 是 server 单例（含 builtin + global + server-cwd），不含其他项目的工作流。
    const projectWorkflows = await discoverWorkflows(ctx.cwd)
    const projectByName = new Map(projectWorkflows.map((w) => [w.meta.name, w]))
    const resolveEntry = (name: string) => registry?.get(name) ?? projectByName.get(name)

    if (subcommand === 'list') {
      // 合并 registry + 项目级（去重：同名项目级覆盖）
      const byName = new Map(registry.list().map((w) => [w.meta.name, w]))
      for (const wf of projectWorkflows) byName.set(wf.meta.name, wf)
      const workflows = Array.from(byName.values())
      const lines = ['可用工作流：']
      for (const wf of workflows) {
        const phases = wf.meta.phases ? ` [${wf.meta.phases.join('→')}]` : ''
        lines.push(`  /${wf.meta.name}${phases}  — ${wf.meta.description} (${wf.source})`)
      }
      lines.push('')
      lines.push('用法：')
      lines.push('  /workflow run <name> [args]     — 执行工作流')
      lines.push('  /workflow create <name> --file <path>  — 从文件创建工作流')
      lines.push('  /workflow edit <name>           — 编辑工作流源码')
      lines.push('  /workflow show <name>           — 查看工作流源码')
      return { _tag: 'text', text: lines.join('\n') }
    }

    if (subcommand === 'show') {
      const name = parts[1]
      if (!name) return { _tag: 'error', message: 'Usage: /workflow show <name>' }
      const wf = resolveEntry(name)
      if (!wf) {
        return { _tag: 'error', message: `未知工作流：${name}` }
      }
      const code = wf.sourceCode ?? '// source not available'
      return {
        _tag: 'text',
        text: `// ${wf.meta.name}: ${wf.meta.description}\n\n${code}`,
      }
    }

    if (subcommand === 'create') {
      const name = parts[1]
      if (!name) return { _tag: 'error', message: 'Usage: /workflow create <name> --file <path>' }

      // 解析 --file <path> 参数
      const fileIdx = parts.indexOf('--file')
      if (fileIdx === -1 || !parts[fileIdx + 1]) {
        return {
          _tag: 'error',
          message:
            'Usage: /workflow create <name> --file <path>\nTip: 也可通过 REST API POST /api/workflows { name, source } 创建',
        }
      }
      const filePath = parts[fileIdx + 1] ?? ''
      // 相对路径以 agent 的 cwd（项目 worktree / CLI 工作目录）解析，而非 serve 进程 cwd——
      // 否则 Web 端 `/workflow create wf --file ./wf.md` 会读错基准目录。
      const resolvedPath = resolve(ctx.cwd, filePath)

      let source: string
      try {
        source = await import('node:fs/promises').then((fs) => fs.readFile(resolvedPath, 'utf-8'))
      } catch {
        return { _tag: 'error', message: `无法读取文件：${resolvedPath}` }
      }

      const result = await saveWorkflow(name, source, 'project', ctx.cwd)
      if (!result.ok) {
        return { _tag: 'error', message: result.error }
      }

      // 热重载注册表
      if (ctx.workflowRegistry) {
        await reloadRegistry(ctx.workflowRegistry, ctx.cwd)
      }

      return {
        _tag: 'success',
        message: `工作流 "${name}" 已保存到 ${result.filePath}\n现在可以用 /workflow run ${name} 执行，或在对话中输入 /${name} 调用。`,
      }
    }

    if (subcommand === 'edit') {
      const name = parts[1]
      if (!name) return { _tag: 'error', message: 'Usage: /workflow edit <name>' }
      const wf = resolveEntry(name)
      if (!wf) {
        return { _tag: 'error', message: `未知工作流：${name}` }
      }
      if (wf.source === 'builtin') {
        return {
          _tag: 'error',
          message: '内置工作流不可编辑。请先复制：/workflow create <新名称> --file <路径>',
        }
      }
      if (!wf.filePath) {
        return { _tag: 'error', message: `工作流 "${name}" 的文件路径不可用` }
      }
      // 斜杠命令经 Web SSE 执行，无法在浏览器里交互式打开终端编辑器——
      // 在 serve 进程 spawn vi 会让用户既看不到也无法输入，SSE 流还会阻塞。
      // 改为给出文件路径引导用户在本地编辑器/文件面板中编辑。
      return {
        _tag: 'error',
        message:
          `Web 端不支持交互式编辑器。请用本地编辑器打开工作流文件后保存：\n` +
          `  ${wf.filePath}\n` +
          `保存后下次 /workflow run ${name} 会读取最新内容（项目工作流按需从磁盘发现）。` +
          `或使用 /workflow create <name> --file <path> 覆盖。`,
      }
    }

    if (subcommand === 'run') {
      const name = parts[1]
      if (!name) return { _tag: 'error', message: 'Usage: /workflow run <name> [args]' }
      const wfArgs = parts.slice(2).join(' ')

      const entry = resolveEntry(name)
      if (!entry) {
        const available = [
          ...registry.list().map((e) => e.meta.name),
          ...projectWorkflows.map((e) => e.meta.name),
        ].join(', ')
        return {
          _tag: 'error',
          message: `未知工作流："${name}"。可用：${available || '(无)'}`,
        }
      }

      const agentConfig = {
        provider: ctx.config.defaultProvider,
        model: ctx.config.defaultModel,
        tools: [],
        plugins: ctx.config.plugins.enabled,
        agentName: 'default',
      }
      const session = await createSession(ctx.deps.db, `workflow:${name}`, undefined, 'workflow')
      const parent = await createAgent(session, agentConfig, ctx.deps)

      return executeWorkflow({
        registry,
        name,
        entry,
        args: wfArgs,
        deps: ctx.deps,
        parent,
      })
    }

    return {
      _tag: 'error',
      message: `未知子命令：${subcommand}。可用：list, run, show, create, edit`,
    }
  },
}

const builtinCommands: SlashCommand[] = [
  helpCommand,
  compactCommand,
  modelCommand,
  clearCommand,
  forkCommand,
  configCommand,
  workflowCommand,
]

export type { SlashRegistry }
export { builtinCommands, createSlashRegistry, parseSlashInput }
