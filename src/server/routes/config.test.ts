import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeConfig } from '../../core/config.js'
import { decryptSecret, isEncryptedSecret } from '../../core/secret.js'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import type { Config } from '../../shared/types/config.js'
import { createServerContext } from '../context.js'
import { createConfigRoute } from './config.js'

let dbHandle: DB | undefined
let tmpCwd: string | undefined

afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
  if (tmpCwd) {
    rmSync(tmpCwd, { recursive: true, force: true })
    tmpCwd = undefined
  }
  vi.restoreAllMocks()
})

async function setup(overrides?: Partial<Config>) {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  tmpCwd = mkdtempSync(join(tmpdir(), 'c0de-cfg-'))
  const config = mergeConfig(overrides)
  const ctx = createServerContext({
    db,
    llmRegistry: createRegistry(),
    config,
    cwd: tmpCwd,
  })
  const app = createConfigRoute(ctx)
  return { app, ctx }
}

function patchBody(app: ReturnType<typeof createConfigRoute>, body: unknown) {
  return app.request('/', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('config route — apiKey 加密（spec §24.2）', () => {
  it('PATCH providers 明文 apiKey → 内存与落盘均加密', async () => {
    const { app, ctx } = await setup({ providers: [] })
    const res = await patchBody(app, {
      providers: [
        { name: 'demo', protocol: 'openai', apiKey: 'sk-plain', baseURL: 'https://demo/v1' },
      ],
    })
    expect(res.status).toBe(200)

    const saved = ctx.config.providers[0]
    expect(saved).toBeDefined()
    expect(isEncryptedSecret(saved?.apiKey ?? '')).toBe(true)
    expect(saved?.apiKey).not.toBe('sk-plain')
    // 解密可还原
    expect(decryptSecret(saved?.apiKey ?? '')).toBe('sk-plain')

    // 落盘文件同样加密
    const file = JSON.parse(readFileSync(join(ctx.cwd, '.c0de', 'config.json'), 'utf-8')) as Config
    const fileProvider = file.providers[0]
    expect(fileProvider).toBeDefined()
    expect(isEncryptedSecret(fileProvider?.apiKey ?? '')).toBe(true)
  })

  it('PATCH providers 已加密 apiKey → 不重复加密', async () => {
    const { app, ctx } = await setup()
    // 先加密一个 apiKey
    const enc = (await import('../../core/secret.js')).encryptSecret('sk-orig')
    const res = await patchBody(app, {
      providers: [{ name: 'demo', protocol: 'openai', apiKey: enc, baseURL: 'https://demo/v1' }],
    })
    expect(res.status).toBe(200)
    expect(ctx.config.providers[0]?.apiKey).toBe(enc) // 原样保留
    expect(decryptSecret(ctx.config.providers[0]?.apiKey ?? '')).toBe('sk-orig')
  })

  it('PATCH providers 无 apiKey → 正常写入不加密', async () => {
    const { app, ctx } = await setup()
    const res = await patchBody(app, {
      providers: [{ name: 'demo', protocol: 'openai', baseURL: 'https://demo/v1' }],
    })
    expect(res.status).toBe(200)
    expect(ctx.config.providers[0]?.apiKey).toBeUndefined()
  })

  it('GET / 不脱敏 apiKey（config route 直接返回；脱敏在 provider route）', async () => {
    const { app } = await setup({
      providers: [{ name: 'demo', protocol: 'openai', apiKey: 'sk-x', baseURL: 'https://demo/v1' }],
    })
    const res = await app.request('/')
    const body = (await res.json()) as Config
    expect(body.providers[0]?.apiKey).toBe('sk-x')
  })
})
