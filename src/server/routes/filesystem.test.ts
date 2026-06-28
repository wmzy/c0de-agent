// filesystem 路由测试，对应 src/server/routes/filesystem.ts
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { createRegistry } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import { createFilesystemRoute } from './filesystem.js'

let dbHandle: DB | undefined
let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'fs-test-'))
  // 创建测试目录结构
  await mkdir(join(tempDir, 'project-a'), { recursive: true })
  await mkdir(join(tempDir, 'project-b'), { recursive: true })
  await mkdir(join(tempDir, '.hidden'), { recursive: true })
})

afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
  await rm(tempDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function setup(cwd?: string) {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd })
  const app = createFilesystemRoute(ctx)
  return { app, ctx }
}

describe('filesystem route', () => {
  it('GET /browse returns subdirectories of given path', async () => {
    const { app } = await setup()
    const res = await app.request(`/browse?path=${encodeURIComponent(tempDir)}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      path: string
      directories: { name: string; path: string }[]
    }
    expect(body.path).toBe(tempDir)
    const names = body.directories.map((d) => d.name)
    expect(names).toContain('project-a')
    expect(names).toContain('project-b')
    // 隐藏目录不出现
    expect(names).not.toContain('.hidden')
  })

  it('GET /browse excludes hidden directories', async () => {
    const { app } = await setup()
    const res = await app.request(`/browse?path=${encodeURIComponent(tempDir)}`)
    const body = (await res.json()) as { directories: { name: string }[] }
    expect(body.directories.every((d) => !d.name.startsWith('.'))).toBe(true)
  })

  it('GET /browse returns empty for non-existent path', async () => {
    const { app } = await setup()
    const res = await app.request(`/browse?path=${encodeURIComponent(join(tempDir, 'nope'))}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { directories: { name: string }[] }
    expect(body.directories).toEqual([])
  })

  it('GET /browse expands ~ to home directory', async () => {
    const { app } = await setup()
    const res = await app.request('/browse?path=~')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { path: string; directories: { name: string }[] }
    // path 应展开为 home 目录
    expect(body.path).not.toBe('~')
    expect(body.path.startsWith('/')).toBe(true)
  })

  it('GET /browse empty path returns home directory', async () => {
    const { app } = await setup()
    const res = await app.request('/browse')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { path: string }
    expect(body.path.startsWith('/')).toBe(true)
  })

  it('GET /browse returns sorted directories', async () => {
    const { app } = await setup()
    const res = await app.request(`/browse?path=${encodeURIComponent(tempDir)}`)
    const body = (await res.json()) as { directories: { name: string }[] }
    const names = body.directories.map((d) => d.name)
    const sorted = [...names].sort()
    expect(names).toEqual(sorted)
  })

  it('GET /home returns home path', async () => {
    const { app } = await setup()
    const res = await app.request('/home')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { path: string }
    expect(body.path.startsWith('/')).toBe(true)
  })

  it('GET /search recursively matches deep directories', async () => {
    // project-a/src/deep/nested
    await mkdir(join(tempDir, 'project-a', 'src', 'deep', 'nested'), { recursive: true })
    const { app } = await setup()
    const res = await app.request(
      `/search?directory=${encodeURIComponent(tempDir)}&q=${encodeURIComponent('nested')}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: string[] }
    // 命中深层目录（相对路径）
    expect(body.items.some((p) => p.includes('nested'))).toBe(true)
    expect(body.items.some((p) => p.includes('src/deep/nested'))).toBe(true)
  })

  it('GET /search only returns directories and skips node_modules/.git/hidden', async () => {
    await mkdir(join(tempDir, 'project-a', 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(tempDir, 'project-a', '.git', 'refs'), { recursive: true })
    await mkdir(join(tempDir, 'project-a', 'src', 'real'), { recursive: true })
    const { app } = await setup()
    const res = await app.request(`/search?directory=${encodeURIComponent(tempDir)}&q=src`)
    const body = (await res.json()) as { items: string[] }
    // 命中 real，但不出现 node_modules/.git 内部
    expect(body.items.some((p) => p.includes('real'))).toBe(true)
    expect(body.items.every((p) => !p.includes('node_modules'))).toBe(true)
    expect(body.items.every((p) => !p.includes('.git'))).toBe(true)
  })

  it('GET /search respects limit', async () => {
    // 创建 6 个匹配目录，limit=3 截断
    for (const name of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']) {
      await mkdir(join(tempDir, 'project-a', name), { recursive: true })
    }
    const { app } = await setup()
    const res = await app.request(`/search?directory=${encodeURIComponent(tempDir)}&q=d&limit=3`)
    const body = (await res.json()) as { items: string[] }
    expect(body.items.length).toBeLessThanOrEqual(3)
  })

  it('GET /search with empty query returns top-level directories', async () => {
    const { app } = await setup()
    const res = await app.request(`/search?directory=${encodeURIComponent(tempDir)}&q=`)
    const body = (await res.json()) as { items: string[] }
    const names = body.items
    expect(names).toContain('project-a')
    expect(names).toContain('project-b')
    expect(names.every((n) => !n.startsWith('.'))).toBe(true)
  })
})
