import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { Hono } from 'hono'
import trash from 'trash'
import { createSummarizer } from '../../core/compact.js'
import { loadConfigScopes, mergeConfig } from '../../core/config.js'
import { buildFallbackChain } from '../../llm/routing.js'
import { getProject } from '../../project/project.js'
import {
  appendToGitignore,
  checkIgnored,
  checkoutGitBranch,
  createGitBranch,
  getGitBranch,
  getGitDiffSummary,
  getGitLastCommit,
  getGitStatus,
  listGitBranches,
  performGitCommit,
} from '../../project/resolve.js'
import { apiError } from '../middleware/error.js'
import { buildRegistryFromConfig } from '../registry-config.js'
import type { ServerContext } from '../types.js'
import { safeResolve } from '../util/safe-path.js'

type FileEntry = {
  name: string
  type: 'file' | 'directory'
  ignored?: boolean
}

type SearchResult = {
  path: string
  type: 'file' | 'directory'
}

/** 递归搜索时跳过的目录（体积大/为元数据噪音，避免递归进入）。
 *  P3：补齐常见构建/缓存产物目录——此前只跳 .git/node_modules，
 *  大仓库每击键全量 walk 时 dist/.cache 等目录拖垮延迟。 */
const SEARCH_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.cache',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  '.vite',
  'target',
  'vendor',
  '__pycache__',
])

/** P3-14：递归收集的结果上限——大仓库无上限返回会拖垮前端渲染。 */
const SEARCH_MAX_RESULTS = 5000

/** 递归收集文件列表（用于搜索）。P3：深度上限 5 → 8，深层文件此前搜不到。
 *  P3-14：达结果上限即停止遍历，防大仓库全量 walk。 */
async function collectFiles(
  dir: string,
  basePath: string,
  maxDepth = 8,
  budget = SEARCH_MAX_RESULTS,
): Promise<SearchResult[]> {
  if (maxDepth < 0 || budget <= 0) return []
  const results: SearchResult[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (results.length >= budget) break
    if (entry.isDirectory() && SEARCH_SKIP_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    const relPath = relative(basePath, fullPath)
    if (entry.isDirectory()) {
      results.push({ path: relPath, type: 'directory' })
      const rest = await collectFiles(fullPath, basePath, maxDepth - 1, budget - results.length)
      results.push(...rest)
    } else {
      results.push({ path: relPath, type: 'file' })
    }
  }
  return results
}

function contentTypeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    pdf: 'application/pdf',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    json: 'application/json; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    ts: 'text/plain; charset=utf-8',
    js: 'text/plain; charset=utf-8',
  }
  return map[ext] ?? 'application/octet-stream'
}

/** P3：.gitignore 追加条目的白名单式校验。suggestions 源自 LLM 输出并经前端
 *  「批准」回传——服务端兜底拒绝换行注入（一条变多条）、全局通配（`*` 直接
 *  忽略整个仓库）与超长/超量条目。合法返回规范化的 trim 后数组，非法返回 null。 */
function sanitizeIgnoreSuggestions(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.length === 0 || raw.length > 100) return null
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return null
    const p = item.trim()
    if (p.length === 0 || p.length > 200) return null
    if (p.includes('\n') || p.includes('\r')) return null
    if (p === '*' || p === '/*' || p === '/') return null
    out.push(p)
  }
  return out.length > 0 ? out : null
}

/** P2 修复：提交信息统一校验（三种模式同口径）。
 *  合法返回 trim 后文本；非法返回判别原因。此前仅 force 模式校验长度/单行，
 *  默认模式（LLM 生成）可把多行/超长 message 原样写入仓库历史。 */
type CommitMessageCheck =
  | { ok: true; message: string }
  | { ok: false; reason: 'EMPTY' | 'TOO_LONG' | 'MULTILINE' }

function checkCommitMessage(raw: unknown): CommitMessageCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'EMPTY' }
  const message = raw.trim()
  if (!message) return { ok: false, reason: 'EMPTY' }
  if (message.length > 500) return { ok: false, reason: 'TOO_LONG' }
  if (/[\r\n]/.test(message)) return { ok: false, reason: 'MULTILINE' }
  return { ok: true, message }
}

/** force/append-ignore 模式的 message 校验错误码映射（保持既有 API 契约）。 */
function rejectCommitMessage(
  c: import('hono').Context,
  reason: 'EMPTY' | 'TOO_LONG' | 'MULTILINE',
  mode: string,
): Response {
  if (reason === 'EMPTY') {
    return apiError(c, 400, 'MISSING_MESSAGE', `mode=${mode} requires a message`)
  }
  if (reason === 'TOO_LONG') {
    return apiError(c, 400, 'MESSAGE_TOO_LONG', 'commit message must be at most 500 characters')
  }
  return apiError(c, 400, 'BAD_REQUEST', 'commit message must be a single line')
}

function createFilesRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // git 状态：返回 path → 状态分类 的映射（非 git 返回空对象）
  app.get('/git-status', async (c) => {
    const projectId = c.req.query('projectId')
    let root = ctx.cwd
    if (projectId) {
      const project = await getProject(ctx.db, projectId)
      if (!project) {
        return apiError(c, 404, 'NOT_FOUND', 'Project not found')
      }
      root = project.worktree
    }
    return c.json(getGitStatus(root) ?? {})
  })

  // 当前分支名（非 git 仓库返回 null）
  app.get('/git-branch', async (c) => {
    const projectId = c.req.query('projectId')
    let root = ctx.cwd
    if (projectId) {
      const project = await getProject(ctx.db, projectId)
      if (!project) {
        return apiError(c, 404, 'NOT_FOUND', 'Project not found')
      }
      root = project.worktree
    }
    return c.json({ branch: getGitBranch(root) })
  })

  // 最后一次提交信息（供分支名 hover tooltip）。非 git 仓库或无提交返回 commit null。
  app.get('/git-last-commit', async (c) => {
    const projectId = c.req.query('projectId')
    let root = ctx.cwd
    if (projectId) {
      const project = await getProject(ctx.db, projectId)
      if (!project) {
        return apiError(c, 404, 'NOT_FOUND', 'Project not found')
      }
      root = project.worktree
    }
    return c.json({ commit: getGitLastCommit(root) })
  })

  // 一键提交：用 LLM 生成 commit message + 检查可疑文件，支持 force/append-ignore 模式
  app.post('/git-commit', async (c) => {
    const projectId = c.req.query('projectId')
    let root = ctx.cwd
    if (projectId) {
      const project = await getProject(ctx.db, projectId)
      if (!project) {
        return apiError(c, 404, 'NOT_FOUND', 'Project not found')
      }
      root = project.worktree
    }
    const summary = getGitDiffSummary(root)
    if (!summary) {
      return apiError(c, 400, 'NO_CHANGES', 'No changes to commit')
    }

    // 可选 body：mode / message / suggestions
    const body = await c.req
      .json()
      .catch(() => ({}) as { mode?: string; message?: string; suggestions?: string[] })

    // --- mode: force — 跳过检查，用传入 message 直接提交 ---
    if (body.mode === 'force') {
      const check = checkCommitMessage(body.message)
      if (!check.ok) return rejectCommitMessage(c, check.reason, 'force')
      const message = check.message
      const result = performGitCommit(root, message)
      if ('error' in result) {
        return apiError(c, 500, 'COMMIT_FAILED', result.error)
      }
      return c.json({
        committed: true,
        message,
        hash: result.hash,
        fileCount: summary.fileCount,
      })
    }

    // --- mode: append-ignore — 追加 .gitignore 后提交 ---
    if (body.mode === 'append-ignore') {
      const check = checkCommitMessage(body.message)
      if (!check.ok) return rejectCommitMessage(c, check.reason, 'append-ignore')
      // P3：suggestions 服务端白名单校验（换行注入/全局通配/超量直接 400）。
      const suggestions = sanitizeIgnoreSuggestions(body.suggestions)
      if (!suggestions) {
        return apiError(
          c,
          400,
          'INVALID_SUGGESTIONS',
          'mode=append-ignore requires valid suggestions (non-empty paths, no newlines, no global wildcards)',
        )
      }
      appendToGitignore(root, suggestions)
      const result = performGitCommit(root, check.message)
      if ('error' in result) {
        return apiError(c, 500, 'COMMIT_FAILED', result.error)
      }
      return c.json({
        committed: true,
        message: check.message,
        hash: result.hash,
        fileCount: summary.fileCount,
      })
    }

    // --- 默认模式：LLM 生成 message + 检查可疑文件 ---
    // P1-1：commitModel/defaultProvider 按项目配置解析（此前一律用服务启动目录配置）。
    let projectConfig = ctx.config
    if (root !== ctx.cwd) {
      const projectScope = loadConfigScopes(root).project
      if (projectScope) projectConfig = mergeConfig(ctx.config, projectScope)
    }
    const cm = projectConfig.commitModel
    const provider = cm?.provider ?? projectConfig.defaultProvider
    const model = cm?.model ?? projectConfig.defaultModel
    const prompt = `Based on the following git diff, generate a concise commit message in conventional-commits format (e.g. "feat: add login page").

ALSO review the changed/new files: are any of them files that SHOULD be in .gitignore but are currently missing? (e.g. secrets, .env, build output, dependencies, temp files, large binaries)

Reply as JSON ONLY:
{"message": "<commit message>", "ignoreSuggestions": ["<path>", ...]}

If no files need ignoring, return an empty array for ignoreSuggestions.

${summary.diff.slice(0, 8000)}`

    let raw: string
    try {
      // P1-1：项目级 provider 注册表（项目配置的 provider 才能路由）。
      const registry =
        root !== ctx.cwd && projectConfig.providers.length > 0
          ? buildRegistryFromConfig(projectConfig)
          : ctx.llmRegistry
      const fallback = buildFallbackChain(projectConfig, provider, model)
      const summarizer = createSummarizer(registry, provider, model, {
        maxTokens: 400,
        ...(fallback ? { fallback } : {}),
      })
      raw = (await summarizer(prompt)).trim()
    } catch (err) {
      return apiError(c, 502, 'LLM_ERROR', `Failed to generate commit message: ${String(err)}`)
    }
    // LLM 返回可能含 markdown 代码块包裹，去掉
    raw = raw
      .replace(/^```[a-z]*\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim()

    // JSON 解析（fail-closed：无法解析 → 报错阻断，不提交）
    let parsed: { message?: string; ignoreSuggestions?: string[] }
    try {
      parsed = JSON.parse(raw)
    } catch {
      return apiError(
        c,
        502,
        'CHECK_PARSE_ERROR',
        'Commit ignore check failed: LLM returned unparseable response',
      )
    }

    const message = (parsed.message ?? '').trim()
    if (!message) {
      return apiError(c, 502, 'EMPTY_MESSAGE', 'LLM returned empty commit message')
    }
    // P2 修复：与 force 模式同口径校验（长度/单行）——LLM 生成物同样不得
    // 把多行/超长内容写入仓库历史。
    const check = checkCommitMessage(message)
    if (!check.ok) {
      return apiError(
        c,
        502,
        'INVALID_LLM_MESSAGE',
        `LLM returned invalid commit message: ${check.reason === 'TOO_LONG' ? '超过 500 字符' : '包含换行'}`,
      )
    }

    const suggestions = Array.isArray(parsed.ignoreSuggestions) ? parsed.ignoreSuggestions : []

    // LLM 检测到可疑文件 → 阻断提交，返回供前端审查
    if (suggestions.length > 0) {
      return c.json({ needsReview: true, message: check.message, suggestions })
    }

    // 无可疑文件 → 直接提交
    const result = performGitCommit(root, check.message)
    if ('error' in result) {
      return apiError(c, 500, 'COMMIT_FAILED', result.error)
    }
    return c.json({
      committed: true,
      message,
      hash: result.hash,
      fileCount: summary.fileCount,
    })
  })

  // 列出本地分支（非 git 仓库返回空数组）
  app.get('/git-branches', async (c) => {
    const projectId = c.req.query('projectId')
    let root = ctx.cwd
    if (projectId) {
      const project = await getProject(ctx.db, projectId)
      if (!project) {
        return apiError(c, 404, 'NOT_FOUND', 'Project not found')
      }
      root = project.worktree
    }
    return c.json({ branches: listGitBranches(root) ?? [] })
  })

  // 切换分支（git checkout）
  app.post('/git-checkout', async (c) => {
    const projectId = c.req.query('projectId')
    let root = ctx.cwd
    if (projectId) {
      const project = await getProject(ctx.db, projectId)
      if (!project) {
        return apiError(c, 404, 'NOT_FOUND', 'Project not found')
      }
      root = project.worktree
    }
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const branch = body.branch as string | undefined
    if (!branch) return apiError(c, 400, 'BAD_REQUEST', 'branch is required')
    const result = checkoutGitBranch(root, branch)
    if ('error' in result) {
      return apiError(c, 500, 'CHECKOUT_FAILED', result.error)
    }
    return c.json({ branch: result.branch })
  })

  // 创建并切换到新分支（git checkout -b）
  app.post('/git-branch-create', async (c) => {
    const projectId = c.req.query('projectId')
    let root = ctx.cwd
    if (projectId) {
      const project = await getProject(ctx.db, projectId)
      if (!project) {
        return apiError(c, 404, 'NOT_FOUND', 'Project not found')
      }
      root = project.worktree
    }
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const name = body.name as string | undefined
    if (!name) return apiError(c, 400, 'BAD_REQUEST', 'name is required')
    const result = createGitBranch(root, name)
    if ('error' in result) {
      return apiError(c, 500, 'BRANCH_CREATE_FAILED', result.error)
    }
    return c.json({ branch: result.branch })
  })

  // 列出目录
  // projectId 指定时按对应项目 worktree 列出，否则回退 ctx.cwd（向后兼容）。
  app.get('/', async (c) => {
    const queryPath = c.req.query('path') ?? '.'
    const projectId = c.req.query('projectId')
    let root = ctx.cwd
    if (projectId) {
      const project = await getProject(ctx.db, projectId)
      if (!project) {
        return apiError(c, 404, 'NOT_FOUND', 'Project not found')
      }
      root = project.worktree
    }
    const resolved = safeResolve(root, queryPath)
    if (!resolved) {
      return apiError(c, 403, 'FORBIDDEN', 'Path outside workspace')
    }
    try {
      const entries = await readdir(resolved, { withFileTypes: true })
      const sorted = entries
        .map((e) => ({
          name: e.name,
          type: (e.isDirectory() ? 'directory' : 'file') as 'file' | 'directory',
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
      // git check-ignore：只检查当前目录直接子项，标记被忽略的文件/目录（灰显用）
      const prefix = queryPath === '.' ? '' : `${queryPath}/`
      const checkPaths = sorted.map((e) => `${prefix}${e.name}`)
      const ignoredSet = checkIgnored(root, checkPaths)
      const result: FileEntry[] = sorted.map((e) => ({
        ...e,
        ...(ignoredSet.has(`${prefix}${e.name}`) ? { ignored: true } : {}),
      }))
      return c.json(result)
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'Directory not found')
    }
  })

  // 搜索文件名
  // projectId 指定时按对应项目 worktree 搜索，否则回退 ctx.cwd（向后兼容）。
  app.get('/search', async (c) => {
    const q = c.req.query('q')
    if (!q) {
      return apiError(c, 400, 'BAD_REQUEST', 'Query parameter q is required')
    }
    const projectId = c.req.query('projectId')
    let root = ctx.cwd
    if (projectId) {
      const project = await getProject(ctx.db, projectId)
      if (!project) {
        return apiError(c, 404, 'NOT_FOUND', 'Project not found')
      }
      root = project.worktree
    }
    const all = await collectFiles(root, root)
    const lower = q.toLowerCase()
    const matched = all.filter((f) => f.path.toLowerCase().includes(lower))
    return c.json(matched)
  })

  // 读取文件
  // projectId 指定时按对应项目 worktree 解析，否则回退 ctx.cwd（向后兼容）。
  app.get('/*', async (c) => {
    const path = c.req.path.replace(/^\/api\/files\//, '').replace(/^\//, '')
    const raw = path.endsWith('/raw')
    const filePath = raw ? path.slice(0, -'/raw'.length) : path
    const projectId = c.req.query('projectId')
    let root = ctx.cwd
    if (projectId) {
      const project = await getProject(ctx.db, projectId)
      if (!project) {
        return apiError(c, 404, 'NOT_FOUND', 'Project not found')
      }
      root = project.worktree
    }
    const resolved = safeResolve(root, filePath)
    if (!resolved) {
      return apiError(c, 403, 'FORBIDDEN', 'Path outside workspace')
    }
    try {
      if (raw) {
        const buf = await readFile(resolved)
        // P2 加固：raw 同源直出，nosniff 防「工作区内 html/svg 被浏览器当
        // 活动文档执行」的同源 XSS 面；html 已改 octet-stream（见 contentTypeFor），
        // svg 保留 image/svg+xml 供 <img> 预览（img 上下文中不执行脚本），
        // 仅对 svg 附加沙箱 CSP 兜底「直接导航打开」场景。
        const contentType = contentTypeFor(filePath)
        return c.body(buf, 200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...(contentType === 'image/svg+xml'
            ? {
                'Content-Security-Policy':
                  "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
              }
            : {}),
        })
      }
      const content = await readFile(resolved, 'utf-8')
      return c.json({ path, content })
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'File not found')
    }
  })

  // 写入文件
  // projectId 指定时按对应项目 worktree 解析，否则回退 ctx.cwd（向后兼容）。
  app.put('/*', async (c) => {
    const path = c.req.path.replace(/^\/api\/files\//, '').replace(/^\//, '')
    const projectId = c.req.query('projectId')
    let root = ctx.cwd
    if (projectId) {
      const project = await getProject(ctx.db, projectId)
      if (!project) {
        return apiError(c, 404, 'NOT_FOUND', 'Project not found')
      }
      root = project.worktree
    }
    const resolved = safeResolve(root, path)
    if (!resolved) {
      return apiError(c, 403, 'FORBIDDEN', 'Path outside workspace')
    }
    // P3-14：content 必须是字符串（此前 undefined/非字符串 → writeFile 抛
    // 类型错误 → 500）；空串合法（清空文件）；超大写入给出明确错误而非 OOM。
    const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null
    if (typeof body?.content !== 'string') {
      return apiError(c, 400, 'BAD_REQUEST', 'content must be a string')
    }
    const MAX_WRITE_BYTES = 20 * 1024 * 1024
    if (Buffer.byteLength(body.content, 'utf8') > MAX_WRITE_BYTES) {
      return apiError(c, 400, 'FILE_TOO_LARGE', '文件超过 20MB 上限，请用本地工具处理')
    }
    try {
      await mkdir(dirname(resolved), { recursive: true })
      await writeFile(resolved, body.content, 'utf-8')
      return c.json({ path, written: true })
    } catch (err) {
      return apiError(c, 500, 'WRITE_ERROR', `Failed to write file: ${String(err)}`)
    }
  })

  // 删除文件/目录（移入系统回收站）
  // projectId 指定时按对应项目 worktree 解析，否则回退 ctx.cwd（向后兼容）。
  app.delete('/*', async (c) => {
    const path = c.req.path.replace(/^\/api\/files\//, '').replace(/^\//, '')
    const projectId = c.req.query('projectId')
    let root = ctx.cwd
    if (projectId) {
      const project = await getProject(ctx.db, projectId)
      if (!project) {
        return apiError(c, 404, 'NOT_FOUND', 'Project not found')
      }
      root = project.worktree
    }
    const resolved = safeResolve(root, path)
    if (!resolved) {
      return apiError(c, 403, 'FORBIDDEN', 'Path outside workspace')
    }
    try {
      await access(resolved)
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'File not found')
    }
    try {
      await trash(resolved)
      return c.json({ path, trashed: true })
    } catch (err) {
      return apiError(c, 500, 'DELETE_ERROR', `Failed to delete file: ${String(err)}`)
    }
  })

  return app
}

export { createFilesRoute }
