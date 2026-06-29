import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  CompactionConfig,
  Config,
  MCPServerConfig,
  SecurityConfig,
  ToolMetricsConfig,
} from '../shared/types/config.js'

const GLOBAL_CONFIG_DIR = '.c0de'
const CONFIG_FILENAME = 'config.json'

const DEFAULT_CONFIG: Config = {
  providers: [],
  defaultProvider: 'openai',
  defaultModel: 'gpt-4o',
  roleRouting: {},
  fallback: { enabled: false, maxRetries: 3, retryDelay: 2000 },
  compaction: {
    enabled: true,
    threshold: 0.8,
    reserveTokens: 8000,
    keepRecentTokens: 4000,
  },
  tools: { enabled: ['read', 'write', 'edit', 'glob', 'grep', 'bash'], disabled: [] },
  plugins: { enabled: [] },
  mcpServers: [],
  slashCommands: { enabled: ['/compact', '/model', '/clear', '/help', '/fork', '/config'] },
  toolMetrics: { enabled: true, threshold: 0.8, minSamples: 5 },
  security: { authEnabled: false, allowedOrigins: [] },
  theme: 'system',
  locale: 'en',
}

function mergeConfig(...configs: (Partial<Config> | undefined)[]): Config {
  const result: Config = structuredClone(DEFAULT_CONFIG)
  for (const cfg of configs) {
    if (!cfg) continue
    for (const key of Object.keys(cfg) as (keyof Config)[]) {
      const val = cfg[key]
      if (val === undefined) continue
      const current = result[key]
      if (
        val !== null &&
        typeof val === 'object' &&
        !Array.isArray(val) &&
        current !== null &&
        typeof current === 'object' &&
        !Array.isArray(current)
      ) {
        ;(result as Record<string, unknown>)[key] = { ...current, ...val }
      } else {
        ;(result as Record<string, unknown>)[key] = val
      }
    }
  }
  return result
}

function readJsonIfExists(path: string): Partial<Config> | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Partial<Config>
  } catch {
    return undefined
  }
}

async function loadConfig(projectDir?: string): Promise<Config> {
  const globalPath = join(homedir(), GLOBAL_CONFIG_DIR, CONFIG_FILENAME)
  const projectPath = join(projectDir ?? process.cwd(), '.c0de', CONFIG_FILENAME)
  const global = readJsonIfExists(globalPath)
  const project = readJsonIfExists(projectPath)
  return mergeConfig(global, project)
}

async function saveConfig(
  config: Config,
  scope: 'global' | 'project',
  projectDir?: string,
): Promise<void> {
  const dir =
    scope === 'global'
      ? join(homedir(), GLOBAL_CONFIG_DIR)
      : join(projectDir ?? process.cwd(), '.c0de')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, CONFIG_FILENAME)
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8')
}

export type { CompactionConfig, Config, MCPServerConfig, SecurityConfig, ToolMetricsConfig }
export { DEFAULT_CONFIG, loadConfig, mergeConfig, saveConfig }
