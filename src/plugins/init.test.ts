// initPlugins 编排测试：config:resolve hook 链在插件激活后执行，产物随结果返回。
// 插件文件走真实发现路径（tmp .c0de/plugins/<name>/index.js + dynamic import），
// 不 mock loader——loadPlugin/activatePlugin 行为由 lifecycle.test/loader.test 覆盖。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../core/config.js'
import { createDefaultRegistry } from '../tools/index.js'
import { initPlugins } from './init.js'

const tmpDirs: string[] = []
afterEach(() => {
  for (const p of tmpDirs.splice(0)) rmSync(p, { recursive: true, force: true })
})

function makePluginCwd(files: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), 'init-plugins-'))
  tmpDirs.push(cwd)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(cwd, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  return cwd
}

const resolveThemePlugin = `export default {
  name: 'theme-resolver',
  version: '1.0.0',
  setup(ctx) {
    ctx.on('config:resolve', (data) => ({ config: { ...data.config, theme: 'light' } }))
  },
}
`

describe('initPlugins config:resolve', () => {
  it('applies plugin config:resolve handlers and returns the resolved config', async () => {
    const cwd = makePluginCwd({
      '.c0de/plugins/theme-resolver/index.js': resolveThemePlugin,
    })
    const result = await initPlugins({
      cwd,
      config: DEFAULT_CONFIG,
      toolRegistry: createDefaultRegistry(),
      llmRegistry: {},
      projectTrusted: true,
    })
    expect(result.config.theme).toBe('light')
    // 原配置未被篡改（handler 展开新对象；插件看到的是激活时传入的引用）
    expect(DEFAULT_CONFIG.theme).toBe('system')
  })

  it('returns the original config when no handler is registered', async () => {
    const cwd = makePluginCwd({})
    const config = { ...DEFAULT_CONFIG }
    const result = await initPlugins({
      cwd,
      config,
      toolRegistry: createDefaultRegistry(),
      llmRegistry: {},
      projectTrusted: true,
    })
    expect(result.config).toBe(config)
  })

  it('keeps the original config when a handler aborts with false', async () => {
    const cwd = makePluginCwd({
      '.c0de/plugins/abort-resolver/index.js': `export default {
  name: 'abort-resolver',
  version: '1.0.0',
  setup(ctx) {
    ctx.on('config:resolve', () => false)
  },
}
`,
    })
    const config = { ...DEFAULT_CONFIG }
    const result = await initPlugins({
      cwd,
      config,
      toolRegistry: createDefaultRegistry(),
      llmRegistry: {},
      projectTrusted: true,
    })
    expect(result.config).toBe(config)
  })
})
