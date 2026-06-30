import { afterEach, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import { createPermissionsRoute } from './permissions.js'

let dbHandle: DB | undefined

afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
})

async function setup() {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  const ctx = createServerContext({ db, llmRegistry: createRegistry() })
  const app = createPermissionsRoute(ctx)
  return { app, ctx }
}

function putMode(app: ReturnType<typeof createPermissionsRoute>, mode: unknown) {
  return app.request('/', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
}

describe('permissions route', () => {
  it('GET / 返回默认 default 模式', async () => {
    const { app } = await setup()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: 'default' })
  })

  it('PUT / 切换到 auto', async () => {
    const { app } = await setup()
    const res = await putMode(app, 'auto')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: 'auto' })
  })

  it('PUT / 非法 mode 返回 400', async () => {
    const { app } = await setup()
    const res = await putMode(app, 'yolo')
    expect(res.status).toBe(400)
  })

  it('PUT / 空 body 返回 400', async () => {
    const { app } = await setup()
    const res = await app.request('/', { method: 'PUT' })
    expect(res.status).toBe(400)
  })

  it('PUT / 后续 GET 反映新值（运行时切换生效）', async () => {
    const { app } = await setup()
    await putMode(app, 'auto')
    const res = await app.request('/')
    expect(await res.json()).toEqual({ mode: 'auto' })
  })
})
