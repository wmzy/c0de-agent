import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkflowEntry } from '../../core/workflows/types.js'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import type { ServerContext } from '../types.js'
import { createWorkflowsRoute } from './workflows.js'

let dbHandle: DB | undefined
let projectCwd: string
const originalHome = process.env.HOME

beforeEach(async () => {
  projectCwd = await mkdtemp(join(tmpdir(), 'wf-api-proj-'))
  // 隔离 HOME：saveWorkflow 和全局发现都读取 homedir()
  const tmpHome = await mkdtemp(join(tmpdir(), 'wf-api-home-'))
  process.env.HOME = tmpHome
})

afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  await rm(projectCwd, { recursive: true, force: true })
})

async function setup() {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  // 隔离 HOME：saveWorkflow 和全局发现都读取 homedir()
  const ctx = createServerContext({
    db,
    llmRegistry: createRegistry(),
    cwd: projectCwd,
  })
  const app = createWorkflowsRoute(ctx)
  return { app, ctx }
}

/** 构造一个不含 workflowRegistry 的最小 ctx，测试 guard 分支。 */
function makeCtxWithoutRegistry(): ServerContext {
  return { workflowRegistry: undefined } as unknown as ServerContext
}

describe('workflows route — GET /', () => {
  it('returns list containing all builtin workflows', async () => {
    const { app } = await setup()
    const res = await app.request('/', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      workflows: Array<{
        name: string
        description: string
        source: string
        phases?: string[]
      }>
    }
    const names = body.workflows.map((w) => w.name)
    expect(names).toContain('security-audit')
    expect(names).toContain('code-review')
    expect(names).toContain('migration-check')

    // 每个 builtin 条目都带 source=builtin 和 phases
    for (const wf of body.workflows) {
      expect(wf.source).toBe('builtin')
      expect(wf.description).toBeTruthy()
      expect(wf.phases).toBeInstanceOf(Array)
    }
  })
})

describe('workflows route — GET /:name', () => {
  it('returns detail for a known builtin workflow', async () => {
    const { app } = await setup()
    const res = await app.request('/security-audit', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      name: string
      description: string
      argsHint: string
      phases: string[]
      source: string
      sourceCode: string
    }
    expect(body.name).toBe('security-audit')
    expect(body.description).toContain('安全审计')
    expect(body.argsHint).toBeTruthy()
    expect(body.phases).toEqual(['scan', 'verify', 'report'])
    expect(body.source).toBe('builtin')
    expect(body.sourceCode).toBeTruthy()
  })

  it('returns 404 NOT_FOUND for unknown name', async () => {
    const { app } = await setup()
    const res = await app.request('/does-not-exist', { method: 'GET' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.message).toContain('does-not-exist')
  })
})

describe('workflows route — DELETE /:name', () => {
  it('returns 400 BAD_REQUEST for a builtin workflow', async () => {
    const { app } = await setup()
    const res = await app.request('/security-audit', { method: 'DELETE' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.message).toContain('builtin')

    // builtin 仍然存在，未被删除
    const { app: app2 } = await setup()
    const verify = await app2.request('/security-audit', { method: 'GET' })
    expect(verify.status).toBe(200)
  })

  it('returns 404 NOT_FOUND for unknown name', async () => {
    const { app } = await setup()
    const res = await app.request('/ghost-workflow', { method: 'DELETE' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('deletes a project-level workflow and returns ok', async () => {
    const { app, ctx } = await setup()
    const fakeEntry: WorkflowEntry = {
      meta: {
        name: 'test-project-wf',
        description: 'A fake project workflow for deletion test',
        argsHint: '[none]',
        phases: ['step1', 'step2'],
      },
      source: 'project',
      execute: async () => ({ output: 'done' }),
      sourceCode: '// fake source',
    }
    ctx.workflowRegistry?.register(fakeEntry)
    expect(ctx.workflowRegistry?.has('test-project-wf')).toBe(true)

    const res = await app.request('/test-project-wf', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    // 已从 registry 中移除
    expect(ctx.workflowRegistry?.has('test-project-wf')).toBe(false)
  })

  it('removes the on-disk file (filePath) on DELETE', async () => {
    const { app, ctx } = await setup()

    // 模拟 .c0de/workflows/<name>.js：在临时目录中写入真实文件
    const dir = await mkdtemp(join(tmpdir(), 'wf-delete-'))
    const filePath = join(dir, 'disk-workflow.js')
    await writeFile(filePath, '// fake on-disk workflow')
    expect(existsSync(filePath)).toBe(true)

    const fakeEntry: WorkflowEntry = {
      meta: {
        name: 'disk-workflow',
        description: 'A workflow backed by a real file',
      },
      source: 'project',
      filePath,
      execute: async () => ({ output: 'done' }),
      sourceCode: '// fake on-disk workflow',
    }
    ctx.workflowRegistry?.register(fakeEntry)

    const res = await app.request('/disk-workflow', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    // 文件已从磁盘删除
    expect(existsSync(filePath)).toBe(false)
    // registry 中也已移除
    expect(ctx.workflowRegistry?.has('disk-workflow')).toBe(false)

    await rm(dir, { recursive: true, force: true })
  })

  it('returns 400 BAD_REQUEST for an invalid name (path traversal guard)', async () => {
    const { app } = await setup()
    // 名称含下划线，不匹配 /^[a-z0-9-]+$/
    const res = await app.request('/bad_name', { method: 'DELETE' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('BAD_REQUEST')
  })

  it('deletes a user-level workflow (source !== builtin)', async () => {
    const { app, ctx } = await setup()
    const fakeEntry: WorkflowEntry = {
      meta: { name: 'test-user-wf', description: 'A user workflow' },
      source: 'user',
      execute: async () => ({ output: 'done' }),
    }
    ctx.workflowRegistry?.register(fakeEntry)

    const res = await app.request('/test-user-wf', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(ctx.workflowRegistry?.has('test-user-wf')).toBe(false)
  })
})

describe('workflows route — registry not initialized', () => {
  it('GET / returns empty list when registry is undefined', async () => {
    const ctx = makeCtxWithoutRegistry()
    const app = createWorkflowsRoute(ctx)
    const res = await app.request('/', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { workflows: unknown[] }
    expect(body.workflows).toEqual([])
  })

  it('GET /:name returns 500 NOT_INITIALIZED when registry is undefined', async () => {
    const ctx = makeCtxWithoutRegistry()
    const app = createWorkflowsRoute(ctx)
    const res = await app.request('/anything', { method: 'GET' })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_INITIALIZED')
  })

  it('DELETE /:name returns 500 NOT_INITIALIZED when registry is undefined', async () => {
    const ctx = makeCtxWithoutRegistry()
    const app = createWorkflowsRoute(ctx)
    const res = await app.request('/anything', { method: 'DELETE' })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_INITIALIZED')
  })
})

describe('workflows route — POST / (create)', () => {
  const VALID_SOURCE = `
export const meta = { name: 'api-wf', description: 'API created workflow', phases: ['scan'] }
export default async function workflow(ctx) {
  return { output: 'from api' }
}
`

  it('creates a valid workflow and reloads registry', async () => {
    const { app, ctx } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'api-wf', source: VALID_SOURCE }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; name: string; description: string; filePath: string; source: string }
    expect(body.ok).toBe(true)
    expect(body.name).toBe('api-wf')
    expect(body.description).toBe('API created workflow')
    expect(body.filePath).toContain('api-wf.js')
    expect(body.source).toBe('project')

    // 注册表热重载后包含新工作流
    expect(ctx.workflowRegistry?.has('api-wf')).toBe(true)

    // 文件确实写入磁盘
    expect(existsSync(body.filePath)).toBe(true)
    const onDisk = await readFile(body.filePath, 'utf-8')
    expect(onDisk).toContain('API created workflow')
  })

  it('returns 400 when name is missing', async () => {
    const { app } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: VALID_SOURCE }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.message).toContain('name')
  })

  it('returns 400 when source is missing', async () => {
    const { app } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'api-wf' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(body.error.message).toContain('source')
  })

  it('returns 400 for invalid name (uppercase)', async () => {
    const { app } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'InvalidName', source: VALID_SOURCE }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('SAVE_FAILED')
    expect(body.error.message).toContain('Invalid workflow name')
  })

  it('returns 400 for source missing default export', async () => {
    const { app } = await setup()
    const badSource = `export const meta = { name: 'bad', description: 'no default' }\n`
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad-wf', source: badSource }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('SAVE_FAILED')
    expect(body.error.message).toContain('default')
  })

  it('returns 500 NOT_INITIALIZED when registry is undefined', async () => {
    const ctx = makeCtxWithoutRegistry()
    const app = createWorkflowsRoute(ctx)
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test', source: VALID_SOURCE }),
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NOT_INITIALIZED')
  })

  it('saves to user dir when target=user', async () => {
    const { app } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'user-wf', source: VALID_SOURCE, target: 'user' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; filePath: string }
    expect(body.ok).toBe(true)
    expect(body.filePath).toContain('.c0de')
    expect(body.filePath).toContain('workflows')
  })
})
