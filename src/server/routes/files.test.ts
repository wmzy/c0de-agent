import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { createRegistry } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import { createFilesRoute } from './files.js'

type FileEntry = { name: string; type: 'file' | 'directory' }

let dbHandle: DB | undefined
afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
})

async function setupWithDir() {
  const dir = mkdtempSync(join(tmpdir(), 'c0de-files-'))
  writeFileSync(join(dir, 'hello.txt'), 'Hello World')
  writeFileSync(join(dir, 'config.json'), '{"key":"value"}')
  mkdirSync(join(dir, 'subdir'))
  writeFileSync(join(dir, 'subdir', 'nested.ts'), 'export const x = 1')
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
  const app = createFilesRoute(ctx)
  return { app, ctx, dir }
}

describe('files route', () => {
  it('GET / lists root directory files', async () => {
    const { app } = await setupWithDir()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const entries = (await res.json()) as FileEntry[]
    const names = entries.map((e) => e.name)
    expect(names).toContain('hello.txt')
    expect(names).toContain('config.json')
    expect(names).toContain('subdir')
    const subdir = entries.find((e) => e.name === 'subdir')
    expect(subdir?.type).toBe('directory')
  })

  it('GET /?path=subdir lists subdirectory', async () => {
    const { app } = await setupWithDir()
    const res = await app.request('/?path=subdir')
    expect(res.status).toBe(200)
    const entries = (await res.json()) as FileEntry[]
    expect(entries.map((e) => e.name)).toContain('nested.ts')
  })

  it('GET /hello.txt reads file content', async () => {
    const { app } = await setupWithDir()
    const res = await app.request('/hello.txt')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { path: string; content: string }
    expect(body.path).toBe('hello.txt')
    expect(body.content).toBe('Hello World')
  })

  it('GET /config.json reads JSON file', async () => {
    const { app } = await setupWithDir()
    const res = await app.request('/config.json')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { path: string; content: string }
    expect(body.content).toBe('{"key":"value"}')
  })

  it('PUT /new.txt writes file', async () => {
    const { app } = await setupWithDir()
    const res = await app.request('/new.txt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'New content' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { path: string; written: boolean }
    expect(body.written).toBe(true)
    const readRes = await app.request('/new.txt')
    const readBody = (await readRes.json()) as { path: string; content: string }
    expect(readBody.content).toBe('New content')
  })

  it('PUT auto-creates parent directories', async () => {
    const { app } = await setupWithDir()
    const res = await app.request('/deep/path/file.txt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'deep' }),
    })
    expect(res.status).toBe(200)
    const readRes = await app.request('/deep/path/file.txt')
    expect(readRes.status).toBe(200)
  })

  it('GET /..%2Fetc%2Fpasswd path traversal rejected', async () => {
    const { app } = await setupWithDir()
    const res = await app.request('/..%2Fetc%2Fpasswd')
    expect(res.status).toBe(403)
  })

  it('GET /nonexistent.txt returns 404', async () => {
    const { app } = await setupWithDir()
    const res = await app.request('/nonexistent.txt')
    expect(res.status).toBe(404)
  })

  it('GET /search?q=hello searches filenames', async () => {
    const { app } = await setupWithDir()
    const res = await app.request('/search?q=hello')
    expect(res.status).toBe(200)
    const results = (await res.json()) as Array<{ path: string; type: string }>
    expect(Array.isArray(results)).toBe(true)
    const paths = results.map((r) => r.path)
    expect(paths.some((p) => p.includes('hello'))).toBe(true)
  })

  it('GET /hello.txt/raw 返回原始字节和 text/plain 类型', async () => {
    const { app } = await setupWithDir()
    const res = await app.request('/hello.txt/raw')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe('Hello World')
  })

  it('GET /search without q returns 400', async () => {
    const { app } = await setupWithDir()
    const res = await app.request('/search')
    expect(res.status).toBe(400)
  })
})
