import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { Hono } from 'hono'
import trash from 'trash'
import { createSummarizer } from '../../core/compact.js'
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

/** 递归搜索时跳过的目录（体积大/为元数据噪音，避免递归进入）。 */
const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules'])

/** 递归收集文件列表（用于搜索）。 */
async function collectFiles(dir: string, basePath: string, maxDepth = 5): Promise<SearchResult[]> {
  if (maxDepth < 0) return []
  const results: SearchResult[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (entry.isDirectory() && SEARCH_SKIP_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    const relPath = relative(basePath, fullPath)
    if (entry.isDirectory()) {
      results.push({ path: relPath, type: 'directory' })
      results.push(...(await collectFiles(fullPath, basePath, maxDepth - 1)))
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
    html: 'text/html; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    ts: 'text/plain; charset=utf-8',
    js: 'text/plain; charset=utf-8',
  }
  return map[ext] ?? 'application/octet-stream'
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
      if (!body.message) {
        return apiError(c, 400, 'MISSING_MESSAGE', 'mode=force requires a message')
      }
      const result = performGitCommit(root, body.message)
      if ('error' in result) {
        return apiError(c, 500, 'COMMIT_FAILED', result.error)
      }
      return c.json({
        committed: true,
        message: body.message,
        hash: result.hash,
        fileCount: summary.fileCount,
      })
    }

    // --- mode: append-ignore — 追加 .gitignore 后提交 ---
    if (body.mode === 'append-ignore') {
      if (!body.message) {
        return apiError(c, 400, 'MISSING_MESSAGE', 'mode=append-ignore requires a message')
      }
      if (!body.suggestions || body.suggestions.length === 0) {
        return apiError(c, 400, 'MISSING_SUGGESTIONS', 'mode=append-ignore requires suggestions')
      }
      appendToGitignore(root, body.suggestions)
      const result = performGitCommit(root, body.message)
      if ('error' in result) {
        return apiError(c, 500, 'COMMIT_FAILED', result.error)
      }
      return c.json({
        committed: true,
        message: body.message,
        hash: result.hash,
        fileCount: summary.fileCount,
      })
    }

    // --- 默认模式：LLM 生成 message + 检查可疑文件 ---
    const cm = ctx.config.commitModel
    const provider = cm?.provider ?? ctx.config.defaultProvider
    const model = cm?.model ?? ctx.config.defaultModel
    const prompt = `Based on the following git diff, generate a concise commit message in conventional-commits format (e.g. "feat: add login page").

ALSO review the changed/new files: are any of them files that SHOULD be in .gitignore but are currently missing? (e.g. secrets, .env, build output, dependencies, temp files, large binaries)

Reply as JSON ONLY:
{"message": "<commit message>", "ignoreSuggestions": ["<path>", ...]}

If no files need ignoring, return an empty array for ignoreSuggestions.

${summary.diff.slice(0, 8000)}`

    let raw: string
    try {
      const summarizer = createSummarizer(ctx.llmRegistry, provider, model, { maxTokens: 400 })
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

    const suggestions = Array.isArray(parsed.ignoreSuggestions) ? parsed.ignoreSuggestions : []

    // LLM 检测到可疑文件 → 阻断提交，返回供前端审查
    if (suggestions.length > 0) {
      return c.json({ needsReview: true, message, suggestions })
    }

    // 无可疑文件 → 直接提交
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
        return c.body(buf, 200, {
          'Content-Type': contentTypeFor(filePath),
          'Cache-Control': 'no-store',
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
    const body = await c.req.json()
    try {
      await mkdir(dirname(resolved), { recursive: true })
      await writeFile(resolved, body.content as string, 'utf-8')
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
