import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { Hono } from 'hono'
import { getProject } from '../../project/project.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'
import { safeResolve } from '../util/safe-path.js'

type FileEntry = {
  name: string
  type: 'file' | 'directory'
}

type SearchResult = {
  path: string
  type: 'file' | 'directory'
}

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
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
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
      const result: FileEntry[] = entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({
          name: e.name,
          type: (e.isDirectory() ? 'directory' : 'file') as 'file' | 'directory',
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
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

  return app
}

export { createFilesRoute }
