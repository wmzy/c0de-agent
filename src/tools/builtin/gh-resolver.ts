// issue:// 与 pr:// URL 解析器（omp internal-urls/issue-pr-protocol 移植，gh CLI 数据源）。
//
// omp 走 SQLite 缓存表 + stale 降级双源；一期刻意不建 PGLite 缓存表（避免动
// drizzle 迁移），每次实时调 gh CLI。GH_TOKEN/GITHUB_TOKEN 环境变量 gh 自动识别，
// 无需自管鉴权；未安装/未登录/超时的错误信息分别引导安装、`gh auth login` 与重试。
//
// URL 文法（omp 口径的一期子集）：
//   issue://N                     默认 repo（按 ctx.cwd 调 `gh repo view --json
//                                nameWithOwner` 解析，进程内缓存 60s）
//   issue://owner/repo/N          全限定单条
//   pr://N / pr://owner/repo/N    PR 详情（附 Diff 提示）
//   pr://N/diff / pr://owner/repo/N/diff   PR unified diff（`gh pr diff`）
// omp 的 list / diff 切片（/diff/all、/diff/<i>）/ 企业 host 前缀 / ?at= 快照
// 均不做——缓存表就位前这些形态没有可靠数据源。
//
// 一期不做缓存表：每次解析实时调 gh（15s 超时、输出截断 100KB）。
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import type { URLResolveContext, URLResolver } from '../../shared/types/tool.js'
import { decodeSegment, stripScheme } from './agent-resolver.js'

type Scheme = 'issue' | 'pr'

/** 单次 gh 子进程的超时。 */
const GH_TIMEOUT_MS = 15_000
/** 渲染内容上限：超过截断并附提示（保护模型上下文）。 */
const MAX_CONTENT_BYTES = 100 * 1024
/** execFile 缓冲上限：大 diff 可能远超渲染上限，先缓冲后截断。 */
const GH_MAX_BUFFER = 4 * 1024 * 1024
/** 默认 repo 解析结果的进程内缓存时长。 */
const DEFAULT_REPO_TTL_MS = 60_000

/** gh 子进程执行结果（promisify(execFile) 的 resolve 形状）。 */
type GhExecResult = { stdout: string; stderr: string }

/** gh 子进程执行器；默认 execFile（15s 超时），测试注入 mock。 */
type GhExecFn = (args: string[], cwd: string) => Promise<GhExecResult>

/** JSON 数据源（args 为 gh CLI 参数形态）；默认 exec + JSON.parse。 */
type FetchJsonFn = (args: string[], cwd: string) => Promise<unknown>

type GhResolverOpts = {
  /** gh 子进程执行器注入点（测试 mock execFile）。 */
  exec?: GhExecFn
  /** JSON 数据源整体覆盖（如改走 GitHub REST API）。注意 diff 通道始终走 exec。 */
  fetchJson?: FetchJsonFn
  /** 默认 repo 缓存时长（默认 60s）；测试注入缩短。 */
  defaultRepoTtlMs?: number
}

type GhResolvers = {
  issueResolver: URLResolver
  prResolver: URLResolver
}

const execFileAsync = promisify(execFileCallback)

function defaultExec(args: string[], cwd: string): Promise<GhExecResult> {
  return execFileAsync('gh', args, { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER })
}

/** 纯十进制正整数解析（omp parsePositiveDecimalInt 口径；0 非法）。 */
function parsePositiveDecimalInt(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return value > 0 ? value : undefined
}

type ParsedGhUrl = {
  /** owner/repo；缺省用默认 repo 解析。 */
  repo?: string
  number: number
  /** pr:// 专属：/diff 后缀。 */
  diff: boolean
}

/** 解析 `issue://` / `pr://` URL 文法（见文件头）。 */
function parseGhUrl(url: string, scheme: Scheme): ParsedGhUrl {
  const parts = stripScheme(url)
    .split('/')
    .map(decodeSegment)
    .filter((p) => p.length > 0)
  // noUncheckedIndexedAccess：解构给空串兜底，各分支按 parts.length 判定后
  // 兜底值必然不参与命中（parsePositiveDecimalInt('') 与 'diff' 比较都落空）。
  const [first = '', second = '', third = '', fourth = ''] = parts
  const usage = `Expected ${scheme}://<number> or ${scheme}://<owner>/<repo>/<number>${
    scheme === 'pr' ? ' (PRs also accept a /diff suffix)' : ''
  }`
  if (parts.length === 1) {
    const number = parsePositiveDecimalInt(first)
    if (number === undefined) {
      throw new Error(`Invalid ${scheme}:// number: ${first}. ${usage}.`)
    }
    return { number, diff: false }
  }
  if (parts.length === 2) {
    // pr://N/diff 短格式。限定 N 为数字：`pr://owner/diff` 保持按「缺编号」报错
    // （owner 名可为字母，与 omp 对 repo 名 diff 的歧义处理同向）。
    if (scheme === 'pr' && second === 'diff') {
      const number = parsePositiveDecimalInt(first)
      if (number !== undefined) return { number, diff: true }
    }
    throw new Error(`Invalid ${scheme}:// URL: missing item number. ${usage}.`)
  }
  if (parts.length === 3) {
    // pr://N/diff/<sub>（/all、/<i>）一期不支持——先于 repo 分支拦截，避免把
    // 'all' 当编号报出误导性错误；repo 真叫 diff 的 owner/diff/N 不受影响
    // （owner 非数字，走下面的正常分支）。
    if (scheme === 'pr' && second === 'diff' && parsePositiveDecimalInt(first) !== undefined) {
      throw new Error(
        `Invalid pr:// diff sub-path "${third}". Only pr://<n>/diff is supported; per-file slices are not available.`,
      )
    }
    const number = parsePositiveDecimalInt(third)
    if (number === undefined) {
      throw new Error(`Invalid ${scheme}:// number: ${third}. ${usage}.`)
    }
    return { repo: `${first}/${second}`, number, diff: false }
  }
  if (parts.length === 4) {
    if (scheme === 'issue') {
      throw new Error(
        'Invalid issue:// URL. Issues do not have a diff; use pr://<owner>/<repo>/<n>/diff for pull requests.',
      )
    }
    if (fourth !== 'diff') {
      throw new Error(`Invalid pr:// suffix "${fourth}". Expected pr://<owner>/<repo>/<n>/diff.`)
    }
    const number = parsePositiveDecimalInt(third)
    if (number === undefined) {
      throw new Error(`Invalid pr:// number: ${third}. Expected pr://<owner>/<repo>/<n>/diff.`)
    }
    return { repo: `${first}/${second}`, number, diff: true }
  }
  throw new Error(`Invalid ${scheme}:// URL. ${usage}.`)
}

/** 首个非空行（gh 的 stderr 常以空行开头）。 */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/**
 * 把 execFile 的失败翻译成可行动的错误：未安装引导安装、未登录引导
 * `gh auth login`（gh 对缺 token 的输出两版本措辞不同，按关键词匹配）、
 * 超时如实报告秒数，其余透传 gh 的 stderr 首行。
 */
function translateGhError(err: unknown, args: string[]): Error {
  const info = err as { code?: unknown; killed?: unknown; message?: unknown; stderr?: unknown }
  if (info?.code === 'ENOENT') {
    return new Error('gh CLI not found on PATH. Install it from https://cli.github.com/ and retry.')
  }
  const message = typeof info?.message === 'string' ? info.message : String(err)
  const stderr = typeof info?.stderr === 'string' ? info.stderr : ''
  const text = `${message}\n${stderr}`
  if (
    /gh auth login|not logged in|To get started with GitHub CLI|requires authentication/i.test(text)
  ) {
    const detail = firstLine(stderr) || firstLine(message) || 'authentication required'
    return new Error(
      `gh is not authenticated (${detail}). Run \`gh auth login\` (or export GH_TOKEN/GITHUB_TOKEN) and retry.`,
    )
  }
  if (info?.killed === true || /TIMEDOUT/i.test(message)) {
    return new Error(`gh ${args.join(' ')} timed out after ${GH_TIMEOUT_MS / 1000}s.`)
  }
  return new Error(
    `gh ${args.join(' ')} failed: ${firstLine(stderr) || firstLine(message) || 'unknown error'}`,
  )
}

/** 包装 exec：失败统一走 translateGhError（注入的 mock exec 同样受益，测试可
 *  直接断言翻译后的未登录/超时文案）。 */
function makeRunner(exec: GhExecFn): GhExecFn {
  return async (args, cwd) => {
    try {
      return await exec(args, cwd)
    } catch (err) {
      throw translateGhError(err, args)
    }
  }
}

/** 默认 JSON 数据源：exec + JSON.parse（--json 输出）。 */
function makeGhJsonFetch(exec: GhExecFn): FetchJsonFn {
  return async (args, cwd) => {
    const { stdout } = await exec(args, cwd)
    try {
      return JSON.parse(stdout)
    } catch {
      throw new Error(`gh ${args.join(' ')}: output is not valid JSON`)
    }
  }
}

const ISSUE_FIELDS = [
  'number',
  'title',
  'state',
  'stateReason',
  'author',
  'labels',
  'createdAt',
  'updatedAt',
  'url',
  'body',
  'comments',
]

const PR_FIELDS = [
  'number',
  'title',
  'state',
  'isDraft',
  'author',
  'labels',
  'createdAt',
  'updatedAt',
  'mergedAt',
  'baseRefName',
  'headRefName',
  'additions',
  'deletions',
  'changedFiles',
  'url',
  'body',
  'comments',
]

/** author.login 的容错读取（ghost 用户/缺失时 '?'）。 */
function loginOf(author: unknown): string {
  if (
    author &&
    typeof author === 'object' &&
    typeof (author as { login?: unknown }).login === 'string'
  ) {
    return (author as { login: string }).login
  }
  return '?'
}

function labelsOf(labels: unknown): string[] {
  if (!Array.isArray(labels)) return []
  return labels.flatMap((label) =>
    label && typeof label === 'object' && typeof (label as { name?: unknown }).name === 'string'
      ? [(label as { name: string }).name]
      : [],
  )
}

type GhComment = { author?: unknown; body?: unknown; createdAt?: unknown }

function commentsOf(data: Record<string, unknown>): GhComment[] {
  const raw = data.comments
  if (!Array.isArray(raw)) return []
  return raw.filter((c): c is GhComment => !!c && typeof c === 'object')
}

function numberText(value: unknown): string {
  return typeof value === 'number' ? String(value) : '?'
}

function titleText(value: unknown): string {
  return typeof value === 'string' && value ? value : '(no title)'
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/** issue 详情的 markdown 渲染（omp buildSingleResource 的无缓存简化版）。 */
function renderIssue(repo: string, data: Record<string, unknown>): string {
  const state = stringOrUndefined(data.state)?.toLowerCase() ?? '?'
  const stateReason = stringOrUndefined(data.stateReason)
  const lines: string[] = [
    `# Issue ${repo}#${numberText(data.number)}: ${titleText(data.title)}`,
    '',
    `- **State:** ${state}${stateReason ? ` (${stateReason})` : ''}`,
    `- **Author:** @${loginOf(data.author)}`,
  ]
  const labels = labelsOf(data.labels)
  if (labels.length > 0) lines.push(`- **Labels:** ${labels.join(', ')}`)
  const created = stringOrUndefined(data.createdAt)
  if (created) lines.push(`- **Created:** ${created}`)
  const updated = stringOrUndefined(data.updatedAt)
  if (updated) lines.push(`- **Updated:** ${updated}`)
  const url = stringOrUndefined(data.url)
  if (url) lines.push(`- **URL:** ${url}`)
  lines.push('', '## Body', '')
  const body = stringOrUndefined(data.body)
  lines.push(body ?? '_No body._')
  const comments = commentsOf(data)
  if (comments.length > 0) {
    lines.push('', `## Comments (${comments.length})`)
    for (const comment of comments) {
      const createdAt = stringOrUndefined(comment.createdAt)
      lines.push('', `**@${loginOf(comment.author)}**${createdAt ? ` · ${createdAt}` : ''}`, '')
      lines.push(stringOrUndefined(comment.body) ?? '_(empty comment)_')
    }
  }
  lines.push('')
  return lines.join('\n')
}

/** pr 详情的 markdown 渲染；末尾附 diff 内部 URL 提示。 */
function renderPr(repo: string, data: Record<string, unknown>): string {
  const number = numberText(data.number)
  const draft = data.isDraft === true ? ' [draft]' : ''
  const lines: string[] = [
    `# Pull Request ${repo}#${number}: ${titleText(data.title)}`,
    '',
    `- **State:** ${stringOrUndefined(data.state)?.toLowerCase() ?? '?'}${draft}`,
    `- **Author:** @${loginOf(data.author)}`,
  ]
  const labels = labelsOf(data.labels)
  if (labels.length > 0) lines.push(`- **Labels:** ${labels.join(', ')}`)
  const head = stringOrUndefined(data.headRefName)
  const base = stringOrUndefined(data.baseRefName)
  if (head && base) lines.push(`- **Branch:** ${head} → ${base}`)
  if (
    typeof data.additions === 'number' &&
    typeof data.deletions === 'number' &&
    typeof data.changedFiles === 'number'
  ) {
    lines.push(
      `- **Changes:** +${data.additions} −${data.deletions} across ${data.changedFiles} file${data.changedFiles === 1 ? '' : 's'}`,
    )
  }
  const created = stringOrUndefined(data.createdAt)
  if (created) lines.push(`- **Created:** ${created}`)
  const updated = stringOrUndefined(data.updatedAt)
  if (updated) lines.push(`- **Updated:** ${updated}`)
  const merged = stringOrUndefined(data.mergedAt)
  if (merged) lines.push(`- **Merged:** ${merged}`)
  const url = stringOrUndefined(data.url)
  if (url) lines.push(`- **URL:** ${url}`)
  lines.push('', '## Body', '')
  lines.push(stringOrUndefined(data.body) ?? '_No body._')
  const comments = commentsOf(data)
  if (comments.length > 0) {
    lines.push('', `## Comments (${comments.length})`)
    for (const comment of comments) {
      const createdAt = stringOrUndefined(comment.createdAt)
      lines.push('', `**@${loginOf(comment.author)}**${createdAt ? ` · ${createdAt}` : ''}`, '')
      lines.push(stringOrUndefined(comment.body) ?? '_(empty comment)_')
    }
  }
  lines.push('', '---', '', `Diff: \`pr://${repo}/${number}/diff\``, '')
  return lines.join('\n')
}

/** pr diff 的渲染：围栏 diff 块（空 diff 如实呈现）。 */
function renderDiff(repo: string, number: number, diff: string): string {
  const trimmed = diff.replace(/\s+$/, '')
  if (!trimmed) return `# Pull Request Diff: ${repo}#${number}\n\n_Empty diff._\n`
  return `# Pull Request Diff: ${repo}#${number}\n\n\`\`\`diff\n${trimmed}\n\`\`\`\n`
}

/** 按字节上限截断并附提示（多字节安全：估位后回退到上限内）。 */
function capContent(content: string): string {
  const total = Buffer.byteLength(content, 'utf8')
  if (total <= MAX_CONTENT_BYTES) return content
  let end = Math.floor((content.length * MAX_CONTENT_BYTES) / total)
  while (end > 0 && Buffer.byteLength(content.slice(0, end), 'utf8') > MAX_CONTENT_BYTES) {
    end -= 64
  }
  return `${content.slice(0, Math.max(end, 0)).replace(/\s+$/, '')}\n\n[Output truncated: exceeded the ${Math.round(MAX_CONTENT_BYTES / 1024)}KB limit. Narrow the request or run gh directly for the full output.]`
}

/**
 * 创建 issue:// 与 pr:// 两个 resolver（共享默认 repo 缓存与数据源注入）。
 * 一期每次实时调 gh：无 PGLite 缓存表（留待后续优化，避免动 drizzle 迁移）。
 */
function createGhResolver(opts?: GhResolverOpts): GhResolvers {
  const exec = makeRunner(opts?.exec ?? defaultExec)
  const fetchJson = opts?.fetchJson ?? makeGhJsonFetch(exec)
  const repoTtl = opts?.defaultRepoTtlMs ?? DEFAULT_REPO_TTL_MS
  const repoCache = new Map<string, { repo: string; expires: number }>()

  /** `gh repo view --json nameWithOwner`（按 cwd），进程内缓存 60s 口径。 */
  const defaultRepo = async (cwd: string): Promise<string> => {
    const hit = repoCache.get(cwd)
    if (hit && hit.expires > Date.now()) return hit.repo
    const data = (await fetchJson(['repo', 'view', '--json', 'nameWithOwner'], cwd)) as {
      nameWithOwner?: unknown
    }
    const repo =
      data && typeof data === 'object' ? stringOrUndefined(data.nameWithOwner) : undefined
    if (!repo) throw new Error('gh repo view returned no nameWithOwner')
    repoCache.set(cwd, { repo, expires: Date.now() + repoTtl })
    return repo
  }

  /** 解析目标 repo：URL 全限定直接用；短格式按 ctx.cwd 解析默认 repo（失败引导全限定形态）。 */
  const resolveRepo = async (
    scheme: Scheme,
    parsed: ParsedGhUrl,
    ctx: URLResolveContext,
  ): Promise<string> => {
    if (parsed.repo) return parsed.repo
    try {
      return await defaultRepo(ctx.cwd)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(
        `${scheme}://${parsed.number}${parsed.diff ? '/diff' : ''} could not resolve the default repo from ${ctx.cwd}: ${message}\nUse ${scheme}://<owner>/<repo>/${parsed.number} instead.`,
      )
    }
  }

  const resolveOne = async (
    scheme: Scheme,
    url: string,
    ctx: URLResolveContext,
  ): Promise<string> => {
    const parsed = parseGhUrl(url, scheme)
    const repo = await resolveRepo(scheme, parsed, ctx)
    if (parsed.diff) {
      // pr diff 走文本通道（fetchJson 覆盖也绕不开 gh：REST patch 端点一期不做）
      const { stdout } = await exec(['pr', 'diff', String(parsed.number), '--repo', repo], ctx.cwd)
      return capContent(renderDiff(repo, parsed.number, stdout))
    }
    const fields = scheme === 'issue' ? ISSUE_FIELDS : PR_FIELDS
    const data = await fetchJson(
      [scheme, 'view', String(parsed.number), '--repo', repo, '--json', fields.join(',')],
      ctx.cwd,
    )
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`gh ${scheme} view #${parsed.number}: unexpected output shape`)
    }
    const item = data as Record<string, unknown>
    const rendered = scheme === 'issue' ? renderIssue(repo, item) : renderPr(repo, item)
    return capContent(rendered)
  }

  return {
    issueResolver: {
      scheme: 'issue',
      resolve: (url, ctx) => resolveOne('issue', url, ctx),
    },
    prResolver: {
      scheme: 'pr',
      resolve: (url, ctx) => resolveOne('pr', url, ctx),
    },
  }
}

export type {
  FetchJsonFn,
  GhExecFn,
  GhExecResult,
  GhResolverOpts,
  GhResolvers,
  ParsedGhUrl,
  Scheme,
}
export { createGhResolver }
