// src/plugins/builtin.ts
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { createLogger } from './logger.js'
import { activatePlugin } from './lifecycle.js'
import { registerPlugin } from './registry.js'
import type { Plugin, PluginRegistry, PluginServices } from './types.js'

function createToolAuditLogger(): Plugin {
  const logger = createLogger('tool-audit')
  return {
    name: 'tool-audit-log',
    version: '1.0.0',
    description: 'Logs all tool execution activity',
    setup: (ctx) => {
      ctx.on('tool:before', (data) => {
        logger.info(`tool:before → ${data.tool}`, { input: data.input })
      })
      ctx.on('tool:after', (data) => {
        const status = data.result._tag
        logger.info(`tool:after ← ${data.tool} [${status}]`)
      })
    },
  }
}

function createWriteGuard(): Plugin {
  const logger = createLogger('write-guard')
  return {
    name: 'write-guard',
    version: '1.0.0',
    description: 'Warns before overwriting existing files',
    setup: (ctx) => {
      ctx.on('tool:before', (data) => {
        if (data.tool !== 'write' && data.tool !== 'edit') return
        const input = data.input as { path?: string; file?: string } | undefined
        const rawPath = input?.path ?? input?.file
        if (typeof rawPath !== 'string') return
        const fullPath = isAbsolute(rawPath) ? rawPath : resolve(data.ctx.cwd, rawPath)
        if (existsSync(fullPath)) {
          logger.warn(`Overwriting existing file: ${fullPath}`)
        }
      }, 50)
    },
  }
}

const BUILTIN_PLUGINS: Plugin[] = [createToolAuditLogger(), createWriteGuard()]

async function registerBuiltinHooks(
  registry: PluginRegistry,
  services: PluginServices,
  names?: string[],
): Promise<void> {
  const selected = names
    ? BUILTIN_PLUGINS.filter((p) => names.includes(p.name))
    : BUILTIN_PLUGINS
  for (const plugin of selected) {
    registerPlugin(registry, plugin)
    await activatePlugin(registry, plugin, services)
  }
}

export { BUILTIN_PLUGINS, createToolAuditLogger, createWriteGuard, registerBuiltinHooks }
