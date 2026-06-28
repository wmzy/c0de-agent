import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { relative as relativePath, resolve as resolvePath } from 'node:path'
import { Hono } from 'hono'
import type { ServerContext } from '../types.js'

/** 目录列表项。 */
type DirEntry = {
  name: string
  path: string
}

/**
 * 列出指定目录下的子目录（仅目录，不含文件）。
 * 用于项目添加时的路径自动补全——可浏览文件系统任意位置。
 *
 * 输入 path 为空时返回 home 目录列表。
 * `~` 开头自动展开为 home 目录。
 */
async function listDirectories(dirPath: string): Promise<DirEntry[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({
      name: e.name,
      path: resolvePath(dirPath, e.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return dirs
}

/** 跳过的目录名（无价值、体量大或为噪音）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache'])

/** 递归搜索目录：从 directory 起收集 type=directory 的相对路径。
 *
 * - 起点经 expandPath 展开 `~`，可为任意绝对路径。
 * - 跳过隐藏目录（`.` 开头）与 SKIP_DIRS。
 * - 限深（默认 5）+ 数量上限 limit（默认 50），避免大目录爆炸。
 * - 匹配：相对路径（小写）includes query（小写），可命中任意层级目录名。
 *
 * 服务端粗筛；客户端 fuzzysort 精排与排序。
 */
async function searchDirectories(
  directory: string,
  query: string,
  limit = 50,
  maxDepth = 5,
): Promise<string[]> {
  const base = directory
  const lowerQuery = query.toLowerCase()
  const results: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (results.length >= limit || depth > maxDepth) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= limit) return
      // 跳过隐藏目录与噪音目录
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const fullPath = resolvePath(dir, entry.name)
      const relPath = relativePath(base, fullPath)
      if (!lowerQuery || relPath.toLowerCase().includes(lowerQuery)) {
        results.push(relPath)
        if (results.length >= limit) return
      }
      await walk(fullPath, depth + 1)
    }
  }

  await walk(base, 0)
  return results.slice(0, limit)
}

/** 把 `~/...` 或空路径展开为绝对路径。 */
function expandPath(input: string): string {
  if (!input || input === '~') return homedir()
  if (input.startsWith('~/')) return resolvePath(homedir(), input.slice(2))
  return resolvePath(input)
}

function createFilesystemRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // 列出目录下的子目录（用于项目路径自动补全）
  app.get('/browse', async (c) => {
    const rawPath = c.req.query('path') ?? ''
    const target = expandPath(rawPath)
    // 校验：ctx 可用于将来做沙箱限制（当前允许浏览任意路径）
    void ctx
    const dirs = await listDirectories(target)
    return c.json({ path: target, directories: dirs })
  })

  // 递归搜索目录（用于项目路径自动补全——命中深层目录）
  app.get('/search', async (c) => {
    const rawDir = c.req.query('directory') ?? ''
    const q = c.req.query('q') ?? ''
    const limitRaw = Number.parseInt(c.req.query('limit') ?? '', 10)
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50
    const directory = expandPath(rawDir)
    const items = await searchDirectories(directory, q, limit)
    return c.json({ items })
  })

  // 列出 home 目录快捷入口
  app.get('/home', (c) => {
    return c.json({ path: homedir() })
  })

  return app
}

export { createFilesystemRoute, expandPath, listDirectories, searchDirectories }
