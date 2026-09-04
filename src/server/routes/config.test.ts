import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
let tmpHome: string | undefined
const originalHome = process.env.HOME

afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
  if (tmpCwd) {
    rmSync(tmpCwd, { recursive: true, force: true })
    tmpCwd = undefined
  }
  if (tmpHome) {
    rmSync(tmpHome, { recursive: true, force: true })
    tmpHome = undefined
  }
  process.env.HOME = originalHome
  vi.restoreAllMocks()
})

async function setup(overrides?: Partial<Config>) {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  tmpCwd = mkdtempSync(join(tmpdir(), 'c0de-cfg-'))
  // 隔离全局作用域：避免读到真实 ~/.c0de/config.json 干扰断言
  tmpHome = mkdtempSync(join(tmpdir(), 'c0de-cfg-home-'))
  process.env.HOME = tmpHome
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
    const body = (await res.json()) as { config: Config }
    expect(body.config.providers[0]?.apiKey).toBe('sk-x')
  })
})

describe('config route — scoped patch 与保存反馈（P1-2/P2-3）', () => {
  it('PATCH security 变更返回 needsRestart: true', async () => {
    const { app } = await setup()
    const res = await patchBody(app, { security: { authEnabled: true } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { needsRestart?: boolean }
    expect(body.needsRestart).toBe(true)
  })

  it('PATCH 非 security 变更 needsRestart 为 false', async () => {
    const { app } = await setup()
    const res = await patchBody(app, { defaultModel: 'gpt-5' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { needsRestart?: boolean }
    expect(body.needsRestart).toBe(false)
  })

  it('PATCH null 键删除该作用域中的键（unset 语义）', async () => {
    const { app, ctx } = await setup()
    // 先落盘两个键，再 unset 其中一个
    await patchBody(app, { defaultModel: 'proj-model', theme: 'dark' })
    const res = await patchBody(app, { defaultModel: null })
    expect(res.status).toBe(200)
    // 内存合并配置回落默认值
    expect(ctx.config.defaultModel).toBe('gpt-4o')
    // 落盘文件不含该键，其余键保留
    const file = JSON.parse(readFileSync(join(ctx.cwd, '.c0de', 'config.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(file.defaultModel).toBeUndefined()
    expect(file.theme).toBe('dark')
  })

  it('落盘失败返回 500 CONFIG_SAVE_FAILED', async () => {
    const { app, ctx } = await setup()
    // 用同名文件占位 .c0de 目录 → saveConfigScoped 的 mkdir/write 失败
    writeFileSync(join(ctx.cwd, '.c0de'), 'not a dir')
    const res = await patchBody(app, { defaultModel: 'gpt-5' })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('CONFIG_SAVE_FAILED')
  })
})
