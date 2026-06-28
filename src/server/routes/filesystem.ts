import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
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

  // 列出 home 目录快捷入口
  app.get('/home', (c) => {
    return c.json({ path: homedir() })
  })

  return app
}

export { createFilesystemRoute, expandPath, listDirectories }
