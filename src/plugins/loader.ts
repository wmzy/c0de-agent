// src/plugins/loader.ts
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from './types.js'

type ValidationResult =
  | { valid: true; plugin: Plugin }
  | { valid: false; error: string }

function validatePluginModule(mod: unknown): ValidationResult {
  const candidate = (mod as { default?: unknown })?.default ?? mod
  if (typeof candidate !== 'object' || candidate === null) {
    return { valid: false, error: 'Plugin module must export an object' }
  }
  const obj = candidate as Record<string, unknown>
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    return { valid: false, error: 'Plugin must have a non-empty "name" string' }
  }
  if (typeof obj.version !== 'string') {
    return { valid: false, error: 'Plugin must have a "version" string' }
  }
  if (typeof obj.setup !== 'function') {
    return { valid: false, error: 'Plugin must have a "setup" function' }
  }
  return { valid: true, plugin: obj as unknown as Plugin }
}

async function loadPlugin(path: string): Promise<Plugin> {
  const mod = await import(path)
  const result = validatePluginModule(mod)
  if (!result.valid) {
    throw new Error(`Invalid plugin at ${path}: ${result.error}`)
  }
  return result.plugin
}

function scanPluginDir(dir: string): { name: string; path: string }[] {
  if (!existsSync(dir)) return []
  const entries = readdirSync(dir)
  const plugins: { name: string; path: string }[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    try {
      if (!statSync(fullPath).isDirectory()) continue
    } catch {
      continue
    }
    const indexPath = join(fullPath, 'index.js')
    if (existsSync(indexPath)) {
      plugins.push({ name: entry, path: fullPath })
    }
  }
  return plugins
}

async function discoverPlugins(
  projectDir: string,
): Promise<{ name: string; path: string; plugin: Plugin }[]> {
  const projectPluginsDir = join(projectDir, '.c0de', 'plugins')
  const globalPluginsDir = join(homedir(), '.c0de', 'plugins')

  const discovered = [...scanPluginDir(projectPluginsDir), ...scanPluginDir(globalPluginsDir)]

  const results: { name: string; path: string; plugin: Plugin }[] = []
  for (const entry of discovered) {
    try {
      const plugin = await loadPlugin(join(entry.path, 'index.js'))
      results.push({ name: entry.name, path: entry.path, plugin })
    } catch {
      // Skip plugins that fail to load
    }
  }
  return results
}

export { discoverPlugins, loadPlugin, validatePluginModule }
