// c0de auth 命令测试：设备列表 / 撤销 / 重置（P1-4 认证恢复）。
// dataDir 经 C0DE_DB_DIR 环境变量隔离（resolveDbDir 读取）。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAuthCommand } from './auth.js'

const tmp = join(tmpdir(), `c0de-authcmd-test-${Date.now()}`)
const originalDbDir = process.env.C0DE_DB_DIR

function seedDevices(devices: unknown[]): void {
  mkdirSync(tmp, { recursive: true })
  writeFileSync(join(tmp, 'devices.json'), JSON.stringify({ version: 1, devices }))
}

beforeEach(() => {
  mkdirSync(tmp, { recursive: true })
  process.env.C0DE_DB_DIR = tmp
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  if (originalDbDir === undefined) delete process.env.C0DE_DB_DIR
  else process.env.C0DE_DB_DIR = originalDbDir
})

describe('c0de auth', () => {
  it('list 无设备时输出提示', async () => {
    const out: string[] = []
    await runAuthCommand({ args: { options: {}, positionals: [] }, write: (s) => out.push(s) })
    expect(out.join('')).toContain('无已授权设备')
  })

  it('list 列出已授权设备', async () => {
    seedDevices([{ id: 'dev-1', name: 'Browser', tokenHash: 'h1', createdAt: 1 }])
    const out: string[] = []
    await runAuthCommand({
      args: { options: {}, positionals: ['list'] },
      write: (s) => out.push(s),
    })
    expect(out.join('')).toContain('dev-1')
    expect(out.join('')).toContain('Browser')
  })

  it('revoke 移除指定设备并落盘', async () => {
    seedDevices([
      { id: 'dev-1', name: 'A', tokenHash: 'h1', createdAt: 1 },
      { id: 'dev-2', name: 'B', tokenHash: 'h2', createdAt: 2 },
    ])
    const out: string[] = []
    await runAuthCommand({
      args: { options: {}, positionals: ['revoke', 'dev-1'] },
      write: (s) => out.push(s),
    })
    const file = JSON.parse(readFileSync(join(tmp, 'devices.json'), 'utf-8')) as {
      devices: Array<{ id: string }>
    }
    expect(file.devices).toHaveLength(1)
    expect(file.devices[0]?.id).toBe('dev-2')
    expect(out.join('')).toContain('已撤销')
  })

  it('revoke 不存在的设备报错', async () => {
    seedDevices([{ id: 'dev-1', name: 'A', tokenHash: 'h1', createdAt: 1 }])
    await expect(
      runAuthCommand({
        args: { options: {}, positionals: ['revoke', 'nope'] },
        write: () => {},
      }),
    ).rejects.toThrow(/not found/i)
  })

  it('revoke 缺少 id 报错', async () => {
    await expect(
      runAuthCommand({ args: { options: {}, positionals: ['revoke'] }, write: () => {} }),
    ).rejects.toThrow(/id/i)
  })

  it('reset 清除 devices.json 与 auth-token 并给出恢复指引', async () => {
    seedDevices([{ id: 'dev-1', name: 'A', tokenHash: 'h1', createdAt: 1 }])
    writeFileSync(join(tmp, 'auth-token'), 'tok123')
    const out: string[] = []
    await runAuthCommand({
      args: { options: {}, positionals: ['reset'] },
      write: (s) => out.push(s),
    })
    expect(existsSync(join(tmp, 'devices.json'))).toBe(false)
    expect(existsSync(join(tmp, 'auth-token'))).toBe(false)
    expect(out.join('')).toContain('重启')
  })

  it('未知子命令报错', async () => {
    await expect(
      runAuthCommand({ args: { options: {}, positionals: ['nope'] }, write: () => {} }),
    ).rejects.toThrow(/unknown/i)
  })
})
