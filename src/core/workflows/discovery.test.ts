import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverWorkflows } from './discovery.js'

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
    await writeWorkflow(
      join(tmpDir, '.c0de/workflows'),
      'broken',
      'this is not valid JS export',
    )
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