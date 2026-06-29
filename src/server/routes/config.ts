import { Hono } from 'hono'
import { mergeConfig, saveConfig } from '../../core/config.js'
import { encryptSecret, isEncryptedSecret } from '../../core/secret.js'
import type { ProviderConfig } from '../../shared/types/llm.js'
import { syncRegistryFromConfig } from '../server.js'
import type { ServerContext } from '../types.js'

function createConfigRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    return c.json(ctx.config)
  })

  app.patch('/', async (c) => {
    const patch = (await c.req.json()) as Record<string, unknown>
    // spec §24.2：provider apiKey 落盘前加密，明文不持久化。
    // 已加密（enc: 前缀）或无 apiKey 的透传。
    if (Array.isArray(patch.providers)) {
      patch.providers = (patch.providers as ProviderConfig[]).map((p) =>
        p.apiKey && !isEncryptedSecret(p.apiKey) ? { ...p, apiKey: encryptSecret(p.apiKey) } : p,
      )
    }
    ctx.config = mergeConfig(ctx.config, patch)
    // providers 变更后原地同步 registry，使运行中的连接立即生效
    syncRegistryFromConfig(ctx.llmRegistry, ctx.config)
    await saveConfig(ctx.config, 'project', ctx.cwd).catch(() => {
      // 保存失败不影响内存配置
    })
    return c.json(ctx.config)
  })

  return app
}

export { createConfigRoute }
