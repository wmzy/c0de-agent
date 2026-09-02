import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import { fromDirectory } from '../../project/project.js'
import { createServerContext } from '../context.js'
import { createFilesRoute } from './files.js'

// mock createSummarizer 以避免真实 LLM 调用；保留 runCompaction 等其他导出
// 使用 vi.hoisted 以便 per-test 覆盖 LLM 返回值（不同测试需要不同的 JSON 响应）
const { mockLLMResponse } = vi.hoisted(() => ({
  mockLLMResponse: {
    value: '{"message":"feat: auto-generated commit message","ignoreSuggestions":[]}',
  },
}))
vi.mock('../../core/compact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/compact.js')>()
  return {
    ...actual,
    createSummarizer: () => async () => mockLLMResponse.value,
  }
})

type FileEntry = { name: string; type: 'file' | 'directory'; ignored?: boolean }

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

  it('GET /search?projectId=... 按项目 worktree 搜索（非 ctx.cwd）', async () => {
    // 两个独立目录，各自注册为 project；ctx.cwd 指向 dirA
    const dirA = mkdtempSync(join(tmpdir(), 'c0de-proj-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'c0de-proj-b-'))
    writeFileSync(join(dirA, 'only-in-a.txt'), 'a')
    writeFileSync(join(dirB, 'only-in-b.txt'), 'b')
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const projectA = await fromDirectory(db, dirA)
    const projectB = await fromDirectory(db, dirB)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dirA })
    const app = createFilesRoute(ctx)

    // 不传 projectId：回退 ctx.cwd（dirA），命中 only-in-a
    const resDefault = await app.request('/search?q=only')
    expect(resDefault.status).toBe(200)
    const defaultPaths = ((await resDefault.json()) as Array<{ path: string }>).map((r) => r.path)
    expect(defaultPaths.some((p) => p.includes('only-in-a'))).toBe(true)
    expect(defaultPaths.some((p) => p.includes('only-in-b'))).toBe(false)

    // 传 projectB.id：应命中 only-in-b 而非 only-in-a
    const resB = await app.request(`/search?q=only&projectId=${projectB.id}`)
    expect(resB.status).toBe(200)
    const bPaths = ((await resB.json()) as Array<{ path: string }>).map((r) => r.path)
    expect(bPaths.some((p) => p.includes('only-in-b'))).toBe(true)
    expect(bPaths.some((p) => p.includes('only-in-a'))).toBe(false)

    // 传 projectA.id：命中 only-in-a
    const resA = await app.request(`/search?q=only&projectId=${projectA.id}`)
    expect(resA.status).toBe(200)
    const aPaths = ((await resA.json()) as Array<{ path: string }>).map((r) => r.path)
    expect(aPaths.some((p) => p.includes('only-in-a'))).toBe(true)
  })

  it('GET /search?projectId=不存在 返回 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-files-'))
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)
    const res = await app.request('/search?q=x&projectId=nonexistent-id')
    expect(res.status).toBe(404)
  })

  it('GET /?projectId=... 按项目 worktree 列出（非 ctx.cwd）', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'c0de-list-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'c0de-list-b-'))
    writeFileSync(join(dirA, 'only-in-a.txt'), 'a')
    writeFileSync(join(dirB, 'only-in-b.txt'), 'b')
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const projectA = await fromDirectory(db, dirA)
    const projectB = await fromDirectory(db, dirB)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dirA })
    const app = createFilesRoute(ctx)

    // 不传 projectId：回退 ctx.cwd（dirA）
    const resDefault = await app.request('/')
    const defaultNames = ((await resDefault.json()) as FileEntry[]).map((e) => e.name)
    expect(defaultNames).toContain('only-in-a.txt')
    expect(defaultNames).not.toContain('only-in-b.txt')

    // 传 projectB.id：列出 dirB
    const resB = await app.request(`/?projectId=${projectB.id}`)
    const bNames = ((await resB.json()) as FileEntry[]).map((e) => e.name)
    expect(bNames).toContain('only-in-b.txt')
    expect(bNames).not.toContain('only-in-a.txt')

    // 传 projectA.id：列出 dirA
    const resA = await app.request(`/?projectId=${projectA.id}`)
    const aNames = ((await resA.json()) as FileEntry[]).map((e) => e.name)
    expect(aNames).toContain('only-in-a.txt')
  })

  it('GET /file?projectId=... 按项目 worktree 读取（非 ctx.cwd）', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'c0de-read-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'c0de-read-b-'))
    writeFileSync(join(dirA, 'shared.txt'), 'from-a')
    writeFileSync(join(dirB, 'shared.txt'), 'from-b')
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const projectB = await fromDirectory(db, dirB)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dirA })
    const app = createFilesRoute(ctx)

    // 不传 projectId：读 dirA
    const resDefault = await app.request('/shared.txt')
    expect(((await resDefault.json()) as { content: string }).content).toBe('from-a')

    // 传 projectB.id：读 dirB
    const resB = await app.request(`/shared.txt?projectId=${projectB.id}`)
    expect(((await resB.json()) as { content: string }).content).toBe('from-b')
  })

  it('PUT /file?projectId=... 写入对应项目 worktree（不污染 ctx.cwd）', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'c0de-put-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'c0de-put-b-'))
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const projectB = await fromDirectory(db, dirB)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dirA })
    const app = createFilesRoute(ctx)

    // 传 projectB.id：写入 dirB
    const res = await app.request(`/shared.txt?projectId=${projectB.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'written-to-b' }),
    })
    expect(res.status).toBe(200)
    // dirB 应存在该文件
    expect(existsSync(join(dirB, 'shared.txt'))).toBe(true)
    expect(readFileSync(join(dirB, 'shared.txt'), 'utf-8')).toBe('written-to-b')
    // dirA（ctx.cwd）不应被污染
    expect(existsSync(join(dirA, 'shared.txt'))).toBe(false)
  })

  it('DELETE /hello.txt 移入回收站', async () => {
    const { app, dir } = await setupWithDir()
    const res = await app.request('/hello.txt', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { path: string; trashed: boolean }
    expect(body.trashed).toBe(true)
    // 文件应已从工作区消失
    expect(existsSync(join(dir, 'hello.txt'))).toBe(false)
  })

  it('DELETE /subdir 移入回收站（目录）', async () => {
    const { app, dir } = await setupWithDir()
    const res = await app.request('/subdir', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(existsSync(join(dir, 'subdir'))).toBe(false)
  })

  it('DELETE /..%2Fetc%2Fpasswd path traversal rejected', async () => {
    const { app } = await setupWithDir()
    const res = await app.request('/..%2Fetc%2Fpasswd', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  it('DELETE /nonexistent.txt returns 404', async () => {
    const { app } = await setupWithDir()
    const res = await app.request('/nonexistent.txt', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('GET / 列出所有隐藏文件/目录（含 .c0de/.git/.env）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-dotfiles-'))
    mkdirSync(join(dir, '.c0de'), { recursive: true })
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, '.env'), 'k=v')
    writeFileSync(join(dir, 'normal.txt'), 'x')
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const names = ((await res.json()) as FileEntry[]).map((e) => e.name)
    expect(names).toContain('.c0de')
    expect(names).toContain('.git')
    expect(names).toContain('.env')
    expect(names).toContain('normal.txt')
  })

  it('GET / git 仓库返回被忽略文件的 ignored 标记', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-list-ignored-'))
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email t@t.com', { cwd: dir })
    execSync('git config user.name t', { cwd: dir })
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n*.log\n')
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'error.log'), 'err')
    writeFileSync(join(dir, 'app.ts'), 'app')
    execSync('git add -A && git commit -q -m init', { cwd: dir })

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const entries = (await res.json()) as FileEntry[]
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]))
    expect(byName.node_modules?.ignored).toBe(true)
    expect(byName['error.log']?.ignored).toBe(true)
    expect(byName['app.ts']?.ignored).toBeUndefined()
  })

  it('GET /search 命中 .c0de 内文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-search-c0de-'))
    mkdirSync(join(dir, '.c0de'), { recursive: true })
    writeFileSync(join(dir, '.c0de', 'config.json'), '{}')
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)
    const res = await app.request('/search?q=config')
    expect(res.status).toBe(200)
    const paths = ((await res.json()) as Array<{ path: string }>).map((r) => r.path)
    expect(paths.some((p) => p.includes('.c0de'))).toBe(true)
  })

  it('GET /git-status 返回状态映射（非 git 返回空对象）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-gitstatus-nogit-'))
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)
    const res = await app.request('/git-status')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({})
  })

  it('GET /git-status 返回 git 变更文件状态', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-gitstatus-'))
    // 初始化 git 仓库
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@test.com', { cwd: dir })
    execSync('git config user.name test', { cwd: dir })
    // 已提交文件
    writeFileSync(join(dir, 'committed.txt'), 'committed')
    execSync('git add -A && git commit -q -m init', { cwd: dir })
    // 未跟踪文件
    writeFileSync(join(dir, 'untracked.txt'), 'new')
    // 已修改文件（未暂存）
    writeFileSync(join(dir, 'committed.txt'), 'changed')
    // 已暂存文件
    writeFileSync(join(dir, 'staged.txt'), 's')
    execSync('git add staged.txt', { cwd: dir })

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)
    const res = await app.request('/git-status')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, string>
    expect(body['untracked.txt']).toBe('untracked')
    expect(body['committed.txt']).toBe('modified')
    expect(body['staged.txt']).toBe('staged')
  })

  it('GET /git-status 不返回 git 忽略文件（去掉 --ignored，避免大仓库性能问题）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-gitignored-'))
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@test.com', { cwd: dir })
    execSync('git config user.name test', { cwd: dir })
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(dir, 'ignored.txt'), 'ignored')
    writeFileSync(join(dir, 'normal.txt'), 'normal')
    execSync('git add -A && git commit -q -m init', { cwd: dir })
    // 修改 .gitignore 后再创建一个被忽略的新文件
    writeFileSync(join(dir, 'ignored2.txt'), 'x2')
    appendFileSync(join(dir, '.gitignore'), 'ignored2.txt\n')

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)
    const res = await app.request('/git-status')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, string>
    // 被忽略文件不返回（去掉 --ignored 后 git status 不再列出）
    expect(body['ignored.txt']).toBeUndefined()
    expect(body['ignored2.txt']).toBeUndefined()
  })

  it('GET /git-branch 返回当前分支名', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-branch-'))
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@test.com', { cwd: dir })
    execSync('git config user.name test', { cwd: dir })
    writeFileSync(join(dir, 'f.txt'), 'x')
    execSync('git add -A && git commit -q -m init', { cwd: dir })
    execSync('git checkout -q -b my-feature', { cwd: dir })

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-branch')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { branch: string | null }
    expect(body.branch).toBe('my-feature')
  })

  it('GET /git-branch 非 git 仓库返回 branch null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-nogit-branch-'))

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-branch')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { branch: string | null }
    expect(body.branch).toBeNull()
  })

  it('GET /git-last-commit 返回最后一次提交信息', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-lastcommit-route-'))
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@test.com', { cwd: dir })
    execSync('git config user.name test', { cwd: dir })
    writeFileSync(join(dir, 'f.txt'), 'x')
    execSync('git add -A && git commit -q -m "feat: initial commit"', { cwd: dir })

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-last-commit')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { commit: { subject: string } | null }
    expect(body.commit).not.toBeNull()
    expect(body.commit?.subject).toBe('feat: initial commit')
  })

  it('GET /git-last-commit 非 git 仓库返回 commit null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-lastcommit-nogit-route-'))

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-last-commit')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { commit: { subject: string } | null }
    expect(body.commit).toBeNull()
  })
})

describe('git-commit route', () => {
  it('POST /git-commit 无变更返回 400 NO_CHANGES', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-commit-empty-'))
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@test.com', { cwd: dir })
    execSync('git config user.name test', { cwd: dir })
    writeFileSync(join(dir, 'file.txt'), 'content')
    execSync('git add -A && git commit -q -m init', { cwd: dir })

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-commit', { method: 'POST' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NO_CHANGES')
  })

  it('POST /git-commit 非 git 仓库返回 400 NO_CHANGES', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-commit-nogit-'))
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-commit', { method: 'POST' })
    expect(res.status).toBe(400)
  })

  it('POST /git-commit 有变更时用 LLM 生成 message 并提交', async () => {
    mockLLMResponse.value =
      '{"message":"feat: auto-generated commit message","ignoreSuggestions":[]}'
    const dir = mkdtempSync(join(tmpdir(), 'c0de-commit-ok-'))
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@test.com', { cwd: dir })
    execSync('git config user.name test', { cwd: dir })
    writeFileSync(join(dir, 'base.txt'), 'base')
    execSync('git add -A && git commit -q -m init', { cwd: dir })
    // 制造变更
    writeFileSync(join(dir, 'new-file.ts'), 'export const x = 1')
    writeFileSync(join(dir, 'base.txt'), 'modified')

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-commit', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      committed: boolean
      message: string
      hash: string
      fileCount: number
    }
    expect(body.committed).toBe(true)
    expect(body.message).toBe('feat: auto-generated commit message')
    expect(body.fileCount).toBeGreaterThan(0)
    // 验证 git log 包含 LLM 生成的 message
    const log = execSync('git log --oneline', { cwd: dir, encoding: 'utf-8' })
    expect(log).toContain('feat: auto-generated commit message')
    // 验证工作区干净
    const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8' })
    expect(status.trim()).toBe('')
  })

  it('POST /git-commit LLM 检测到可疑文件时返回 needsReview', async () => {
    mockLLMResponse.value = '{"message":"feat: add config","ignoreSuggestions":[".env","dist/"]}'

    const dir = mkdtempSync(join(tmpdir(), 'c0de-commit-review-'))
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@test.com', { cwd: dir })
    execSync('git config user.name test', { cwd: dir })
    writeFileSync(join(dir, 'base.txt'), 'base')
    execSync('git add -A && git commit -q -m init', { cwd: dir })
    writeFileSync(join(dir, 'new-file.ts'), 'export const x = 1')

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-commit', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      needsReview?: boolean
      message?: string
      suggestions?: string[]
    }
    expect(body.needsReview).toBe(true)
    expect(body.message).toBe('feat: add config')
    expect(body.suggestions).toEqual(['.env', 'dist/'])
    // 没有实际提交
    const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8' })
    expect(status.trim()).not.toBe('')
  })

  it('POST /git-commit LLM 返回无法解析的响应时返回 502', async () => {
    mockLLMResponse.value = 'This is not valid JSON at all'

    const dir = mkdtempSync(join(tmpdir(), 'c0de-commit-parseerr-'))
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@test.com', { cwd: dir })
    execSync('git config user.name test', { cwd: dir })
    writeFileSync(join(dir, 'base.txt'), 'base')
    execSync('git add -A && git commit -q -m init', { cwd: dir })
    writeFileSync(join(dir, 'new-file.ts'), 'export const x = 1')

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-commit', { method: 'POST' })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('CHECK_PARSE_ERROR')
    // 没有实际提交
    const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8' })
    expect(status.trim()).not.toBe('')
  })

  it('POST /git-commit mode=force 跳过检查直接提交', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-commit-force-'))
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@test.com', { cwd: dir })
    execSync('git config user.name test', { cwd: dir })
    writeFileSync(join(dir, 'base.txt'), 'base')
    execSync('git add -A && git commit -q -m init', { cwd: dir })
    writeFileSync(join(dir, 'new-file.ts'), 'export const x = 1')

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'force', message: 'feat: force commit' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { committed: boolean; message: string }
    expect(body.committed).toBe(true)
    expect(body.message).toBe('feat: force commit')
    const log = execSync('git log --oneline', { cwd: dir, encoding: 'utf-8' })
    expect(log).toContain('feat: force commit')
  })

  it('POST /git-commit mode=append-ignore 追加 .gitignore 后提交', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-commit-appendignore-'))
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@test.com', { cwd: dir })
    execSync('git config user.name test', { cwd: dir })
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
    writeFileSync(join(dir, 'base.txt'), 'base')
    execSync('git add -A && git commit -q -m init', { cwd: dir })
    writeFileSync(join(dir, 'new-file.ts'), 'export const x = 1')

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'append-ignore',
        message: 'feat: add feature',
        suggestions: ['.env', 'dist/'],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { committed: boolean; message: string }
    expect(body.committed).toBe(true)
    expect(body.message).toBe('feat: add feature')
    // .gitignore 被追加了新条目
    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('.env')
    expect(gitignore).toContain('dist/')
    expect(gitignore).toContain('node_modules')
    // git log 包含提交
    const log = execSync('git log --oneline', { cwd: dir, encoding: 'utf-8' })
    expect(log).toContain('feat: add feature')
  })

  it('POST /git-commit mode=force 缺少 message 返回 400', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-commit-nomsg-'))
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@test.com', { cwd: dir })
    execSync('git config user.name test', { cwd: dir })
    writeFileSync(join(dir, 'f.txt'), 'x')
    execSync('git add -A && git commit -q -m init', { cwd: dir })
    writeFileSync(join(dir, 'f.txt'), 'changed')

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'force' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('MISSING_MESSAGE')
  })
})
