// 假服务器（fixtures/fake-server.mjs，node 脚本）驱动的 client 集成测试：
// 覆盖 initialize 握手、didOpen 诊断等待（version 命中 + settle 窗口两路径）、
// workspace/configuration 应答、LocationLink 归一（纯函数）、pending 超时、
// 服务器退出 failAll。全部离线，不依赖真实语言服务器。

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { createLspClient, normalizeLocations } from './client.js'
import type { LspClient } from './types.js'
import { pathToFileUri } from './types.js'

const fixtureDir = dirname(fileURLToPath(import.meta.url))
const fakeServer = join(fixtureDir, 'fixtures', 'fake-server.mjs')
const workRoot = await mkdtemp(join(tmpdir(), 'lsp-client-'))

/** 假服务器定义：command 为 node 可执行文件、args 指向 fixture 脚本。 */
function fakeServerDef(extra?: { settings?: Record<string, unknown> }) {
  return {
    name: 'fake-lsp',
    command: process.execPath,
    args: [fakeServer],
    fileTypes: ['ts'],
    rootMarkers: [],
    ...(extra?.settings ? { settings: extra.settings } : {}),
  }
}

/** 启动假服务器并完成握手；返回客户端与 initialize 结果。 */
async function startClient(
  env?: Record<string, string>,
  settings?: Record<string, unknown>,
): Promise<{ client: LspClient; init: Record<string, unknown> }> {
  const workspaceRoot = await mkdtemp(join(workRoot, 'ws-'))
  const client = createLspClient({
    server: fakeServerDef({ settings }),
    binary: process.execPath,
    workspaceRoot,
    env,
  })
  const init = (await client.initialize()) as Record<string, unknown>
  return { client, init }
}

async function createClient(
  env?: Record<string, string>,
  settings?: Record<string, unknown>,
): Promise<LspClient> {
  return (await startClient(env, settings)).client
}

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

describe('createLspClient', () => {
  it('completes the initialize handshake and reports server capabilities', async () => {
    const client = await createClient()
    const raw = await client.request('textDocument/definition', {
      textDocument: { uri: pathToFileUri('/tmp/a.ts') },
      position: { line: 0, character: 0 },
    })
    expect(Array.isArray(raw)).toBe(true)
    await client.dispose()
  })

  it('answers workspace/configuration pulls from settings (missing section → null)', async () => {
    const { client, init } = await startClient(
      { FAKE_LSP_ASK_CONFIG: '1' },
      {
        fake: { one: 42 },
      },
    )
    // 假服务器在回 initialize 之前先拉 workspace/configuration，
    // 把应答放进 initialize 结果的 configEcho。
    expect(init.configEcho).toEqual([42, null])
    expect((init.serverInfo as { name?: string })?.name).toBe('fake-lsp')
    await client.dispose()
  })

  it('waits for fresh diagnostics via exact version match (echo path)', async () => {
    const client = await createClient()
    const file = join(await mkdtemp(join(workRoot, 'doc-')), 'a.ts')
    await writeFile(file, 'const foo = 1\n')
    const rec = await client.reconcileFromDisk(file)
    expect(rec.version).toBe(1)
    const fresh = await client.waitForDiagnostics(rec.uri, rec.version, 5000)
    expect(fresh.stale).toBe(false)
    // 假服务器固定 3 条（含 1 条重复），客户端原样缓存。
    expect(fresh.diagnostics).toHaveLength(3)
    expect(client.diagnosticsFor(rec.uri)).toHaveLength(3)
    await client.dispose()
  })

  it('waits for fresh diagnostics via the settle window when version is not echoed', async () => {
    const client = await createClient({ FAKE_LSP_DIAG_VERSION: 'omit' })
    const file = join(await mkdtemp(join(workRoot, 'doc-')), 'a.ts')
    await writeFile(file, 'const foo = 1\n')
    const rec = await client.reconcileFromDisk(file)
    const started = Date.now()
    const fresh = await client.waitForDiagnostics(rec.uri, rec.version, 5000)
    expect(fresh.stale).toBe(false)
    expect(fresh.diagnostics.length).toBeGreaterThan(0)
    // settle 窗口 300ms：至少要等满窗口才采信。
    expect(Date.now() - started).toBeGreaterThanOrEqual(280)
    await client.dispose()
  })

  it('resyncs on disk change via didChange (version increments)', async () => {
    const client = await createClient()
    const file = join(await mkdtemp(join(workRoot, 'doc-')), 'a.ts')
    await writeFile(file, 'const foo = 1\n')
    const first = await client.reconcileFromDisk(file)
    const unchanged = await client.reconcileFromDisk(file)
    expect(unchanged.version).toBe(first.version)
    await writeFile(file, 'const foo = 2\n')
    const second = await client.reconcileFromDisk(file)
    expect(second.version).toBe(first.version + 1)
    const fresh = await client.waitForDiagnostics(second.uri, second.version, 5000)
    expect(fresh.stale).toBe(false)
    await client.dispose()
  })

  it('rejects requests with the JSON-RPC error message', async () => {
    const client = await createClient()
    await expect(client.request('test/no-such-method', {}, 2000)).rejects.toThrow(
      /Method not found/,
    )
    await client.dispose()
  })

  it('times out pending requests that the server never answers', async () => {
    const client = await createClient()
    await expect(client.request('test/hang', {}, 300)).rejects.toThrow(/timed out after 300ms/)
    await client.dispose()
  })

  it('fails all pending requests when the server exits', async () => {
    const client = await createClient()
    const pending = client.request('test/hang', {}, 10_000)
    client.notify('test/exit')
    await expect(pending).rejects.toThrow(/exited unexpectedly/)
    expect(client.isDead()).toBe(true)
    await expect(client.request('textDocument/hover', {}, 1000)).rejects.toThrow(
      /no longer running/,
    )
    await client.dispose()
  })

  it('normalizes LocationLink results to locations using targetSelectionRange', () => {
    const uri = 'file:///x/a.ts'
    const link = {
      originSelectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      targetUri: uri,
      targetRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 7 } },
      targetSelectionRange: { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } },
    }
    expect(normalizeLocations([link])).toEqual([{ uri, range: link.targetSelectionRange }])
    expect(normalizeLocations(null)).toEqual([])
    expect(normalizeLocations([{ uri, range: link.targetRange }])).toEqual([
      { uri, range: link.targetRange },
    ])
    // LocationLink 无 targetSelectionRange 时回退 targetRange。
    expect(normalizeLocations([{ targetUri: uri, targetRange: link.targetRange }])).toEqual([
      { uri, range: link.targetRange },
    ])
  })
})
