import { Hono } from 'hono'
import { loadConfigScopes, mergeConfig, mergeRaw, saveConfigScoped } from '../../core/config.js'
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../../core/secret.js'
import type { Config } from '../../shared/types/config.js'
import type { ProviderConfig } from '../../shared/types/llm.js'
import { syncRegistryFromConfig } from '../server.js'
import type { ServerContext } from '../types.js'

/** 检查每个 provider 的 apiKey 能否在本机解密（机器绑定密钥换机/容器重建后会失败）。 */
function providerApiKeyWarnings(providers: Config['providers']): string[] {
  const warnings: string[] = []
  for (const p of providers) {
    if (!p.apiKey || !isEncryptedSecret(p.apiKey)) continue
    try {
      decryptSecret(p.apiKey)
    } catch {
      warnings.push(
        `provider "${p.name || '(未命名)'}" 的 API Key 无法在本机解密（密钥与机器绑定）。` +
          '若配置来自其他机器或容器重建，请重新填写 API Key。',
      )
    }
  }
  return warnings
}

function createConfigRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // GET / — 合并后配置 + 作用域信息 + apiKey 解密警告
  app.get('/', (c) => {
    const scopes = loadConfigScopes(ctx.cwd)
    return c.json({
      config: ctx.config,
      scopes: {
        global: scopes.global ?? null,
        project: scopes.project ?? null,
      },
      warnings: providerApiKeyWarnings(ctx.config.providers),
    })
  })

  // PATCH / — 按作用域写入。body.scope: 'global' | 'project'（默认 project，兼容旧客户端）。
  app.patch('/', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown> & { scope?: 'global' | 'project' }
    const scope = body.scope === 'global' ? 'global' : 'project'
    const { scope: _omit, ...patch } = body
    // spec §24.2：provider apiKey 落盘前加密，明文不持久化。
    // 已加密（enc: 前缀）或无 apiKey 的透传。
    if (Array.isArray(patch.providers)) {
      patch.providers = (patch.providers as ProviderConfig[]).map((p) =>
        p.apiKey && !isEncryptedSecret(p.apiKey) ? { ...p, apiKey: encryptSecret(p.apiKey) } : p,
      )
    }
    // 按作用域最小落盘：patch 只合并进指定作用域原始文件，
    // 不把合并结果（含默认值/另一作用域配置）整体序列化进文件。
    const scopes = loadConfigScopes(ctx.cwd)
    const nextScoped =
      scope === 'global'
        ? mergeRaw(scopes.global ?? {}, patch)
        : mergeRaw(scopes.project ?? {}, patch)
    ctx.config =
      scope === 'global'
        ? mergeConfig(nextScoped as Partial<Config>, scopes.project)
        : mergeConfig(scopes.global, nextScoped as Partial<Config>)
    // providers 变更后原地同步 registry，使运行中的连接立即生效
    syncRegistryFromConfig(ctx.llmRegistry, ctx.config)
    await saveConfigScoped(scope, ctx.cwd, nextScoped).catch(() => {
      // 保存失败不影响内存配置
    })
    return c.json({
      config: ctx.config,
      scope,
      warnings: providerApiKeyWarnings(ctx.config.providers),
    })
  })

  return app
}

export { createConfigRoute }
