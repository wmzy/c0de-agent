import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverGlobalWorkflows, discoverWorkflows, saveWorkflow } from './discovery.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'wf-disc-'))
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeWorkflow(dir: string, name: string, source: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${name}.js`), source, 'utf-8')
}

const VALID_WORKFLOW = `
export const meta = { name: 'test-wf', description: 'test workflow' }
export default async function workflow(ctx) {
  return { output: 'done' }
}
`

describe('discoverWorkflows', () => {
  it('loads valid .js workflow files from project .c0de/workflows/', async () => {
    await writeWorkflow(join(tmpDir, '.c0de/workflows'), 'test-wf', VALID_WORKFLOW)
    const entries = await discoverWorkflows(tmpDir)
    expect(entries.length).toBe(1)
    expect(entries[0]?.meta.name).toBe('test-wf')
    expect(entries[0]?.source).toBe('project')
    expect(entries[0]?.sourceCode).toContain('test workflow')
    expect(typeof entries[0]?.execute).toBe('function')
  })

  it('skips files that fail to import and continues loading others', async () => {
    await writeWorkflow(join(tmpDir, '.c0de/workflows'), 'broken', 'this is not valid JS export')
    await writeWorkflow(join(tmpDir, '.c0de/workflows'), 'good', VALID_WORKFLOW)
    const entries = await discoverWorkflows(tmpDir)
    // broken 文件（无 meta/default 导出）应跳过，good 应正常加载
    const names = entries.map((e) => e.meta.name)
    expect(names).toContain('test-wf')
    expect(names).not.toContain('broken')
  })

  it('returns empty array when no .c0de/workflows directory exists', async () => {
    const entries = await discoverWorkflows(tmpDir)
    expect(entries).toEqual([])
  })

  it('uses filename as fallback name when meta.name is missing', async () => {
    const noName = `
export const meta = { description: 'no name field' }
export default async function workflow(ctx) {
  return { output: 'ok' }
}
`
    await writeWorkflow(join(tmpDir, '.c0de/workflows'), 'fallback-name', noName)
    const entries = await discoverWorkflows(tmpDir)
    expect(entries[0]?.meta.name).toBe('fallback-name')
  })

  it('skips files without meta export', async () => {
    const noMeta = `
export default async function workflow(ctx) {
  return { output: 'ok' }
}
`
    await writeWorkflow(join(tmpDir, '.c0de/workflows'), 'no-meta', noMeta)
    const entries = await discoverWorkflows(tmpDir)
    expect(entries.length).toBe(0)
  })

  it('skips files without default export', async () => {
    const noDefault = `
export const meta = { name: 'no-default', description: 'x' }
`
    await writeWorkflow(join(tmpDir, '.c0de/workflows'), 'no-default', noDefault)
    const entries = await discoverWorkflows(tmpDir)
    expect(entries.length).toBe(0)
  })
})

describe('discoverGlobalWorkflows', () => {
  // 全局发现读取 os.homedir() → process.env.HOME（POSIX），用临时 HOME 隔离测试。
  const originalHome = process.env.HOME
  let globalHomeDir: string

  beforeEach(async () => {
    globalHomeDir = await mkdtemp(join(tmpdir(), 'wf-global-home-'))
    process.env.HOME = globalHomeDir
  })

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    await rm(globalHomeDir, { recursive: true, force: true })
  })

  it('loads valid .js workflow files from ~/.c0de/workflows/ with source:user', async () => {
    await writeWorkflow(join(globalHomeDir, '.c0de/workflows'), 'global-wf', VALID_WORKFLOW)
    const entries = await discoverGlobalWorkflows()
    expect(entries.length).toBe(1)
    expect(entries[0]?.meta.name).toBe('test-wf')
    expect(entries[0]?.source).toBe('user')
    expect(entries[0]?.filePath).toBe(join(globalHomeDir, '.c0de/workflows', 'global-wf.js'))
    expect(entries[0]?.sourceCode).toContain('test workflow')
    expect(typeof entries[0]?.execute).toBe('function')
  })

  it('skips malformed files and continues loading others', async () => {
    await writeWorkflow(join(globalHomeDir, '.c0de/workflows'), 'broken', 'not valid js export')
    await writeWorkflow(join(globalHomeDir, '.c0de/workflows'), 'good', VALID_WORKFLOW)
    const entries = await discoverGlobalWorkflows()
    const names = entries.map((e) => e.meta.name)
    expect(names).toContain('test-wf')
    expect(names).not.toContain('broken')
  })

  it('returns empty array when ~/.c0de/workflows does not exist', async () => {
    const entries = await discoverGlobalWorkflows()
    expect(entries).toEqual([])
  })

  it('uses filename as fallback name when meta.name is missing', async () => {
    const noName = `
export const meta = { description: 'no name field' }
export default async function workflow(ctx) {
  return { output: 'ok' }
}
`
    await writeWorkflow(join(globalHomeDir, '.c0de/workflows'), 'fallback-global', noName)
    const entries = await discoverGlobalWorkflows()
    expect(entries[0]?.meta.name).toBe('fallback-global')
    expect(entries[0]?.source).toBe('user')
  })
})

describe('saveWorkflow', () => {
  const originalHome = process.env.HOME
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'wf-save-home-'))
    process.env.HOME = homeDir
  })

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    await rm(homeDir, { recursive: true, force: true })
  })

  const VALID_SOURCE = `
export const meta = { name: 'my-wf', description: 'saved workflow', phases: ['scan', 'report'] }
export default async function workflow(ctx) {
  return { output: 'done' }
}
`

  it('saves valid workflow to project dir and returns meta + filePath', async () => {
    const result = await saveWorkflow('my-wf', VALID_SOURCE, 'project', tmpDir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.name).toBe('my-wf')
      expect(result.meta.description).toBe('saved workflow')
      expect(result.filePath).toBe(join(tmpDir, '.c0de/workflows', 'my-wf.js'))
    }
    // 保存后能被 discoverWorkflows 发现
    const entries = await discoverWorkflows(tmpDir)
    expect(entries.some((e) => e.meta.name === 'my-wf')).toBe(true)
  })

  it('saves valid workflow to user (~/.c0de/workflows) dir', async () => {
    const result = await saveWorkflow('my-wf', VALID_SOURCE, 'user')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.filePath).toBe(join(homeDir, '.c0de', 'workflows', 'my-wf.js'))
    }
  })

  it('rejects invalid name with path traversal characters', async () => {
    const result = await saveWorkflow('../etc/passwd', VALID_SOURCE, 'project', tmpDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Invalid workflow name')
    }
  })

  it('rejects invalid name with uppercase letters', async () => {
    const result = await saveWorkflow('MyWorkflow', VALID_SOURCE, 'project', tmpDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Invalid workflow name')
    }
  })

  it('rejects source missing meta export', async () => {
    const badSource = `
export default async function workflow(ctx) {
  return { output: 'done' }
}
`
    const result = await saveWorkflow('bad-wf', badSource, 'project', tmpDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('meta')
    }
  })

  it('rejects source missing default export', async () => {
    const badSource = `
export const meta = { name: 'bad-wf', description: 'no default' }
`
    const result = await saveWorkflow('bad-wf', badSource, 'project', tmpDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('default')
    }
  })

  it('uses filename as fallback name when meta.name is absent', async () => {
    const noNameSource = `
export const meta = { description: 'fallback name' }
export default async function workflow(ctx) {
  return { output: 'ok' }
}
`
    const result = await saveWorkflow('fallback-name', noNameSource, 'project', tmpDir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.name).toBe('fallback-name')
    }
  })
})
