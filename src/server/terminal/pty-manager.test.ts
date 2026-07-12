// src/server/terminal/pty-manager.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userInfo } from 'node:os'
import { PTYManager, detectShell } from './pty-manager.js'

describe('PTYManager', () => {
  let mgr: PTYManager

  beforeEach(() => {
    mgr = new PTYManager()
  })

  afterEach(() => {
    mgr.dispose()
  })

  it('create spawns a shell and returns PTY info', () => {
    const info = mgr.create({ cwd: '/tmp' })
    expect(info.id).toMatch(/^pty_/)
    expect(info.pid).toBeGreaterThan(0)
    expect(info.cols).toBe(80)
    expect(info.rows).toBe(24)
    expect(info.shell).toBeTruthy()
    expect(mgr.get(info.id)).toBeDefined()
  })

  it('list returns all active PTY sessions', () => {
    const a = mgr.create({ cwd: '/tmp', title: 'term-a' })
    const b = mgr.create({ cwd: '/tmp', title: 'term-b' })
    const list = mgr.list()
    expect(list).toHaveLength(2)
    expect(list.map((i) => i.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('kill terminates the PTY and removes it from list', () => {
    const info = mgr.create({ cwd: '/tmp' })
    mgr.kill(info.id)
    expect(mgr.get(info.id)).toBeUndefined()
    expect(mgr.list()).toHaveLength(0)
  })

  it('write throws for unknown id', () => {
    expect(() => mgr.write('nonexistent', 'hello')).toThrow('PTY not found')
  })

  it('resize throws for unknown id', () => {
    expect(() => mgr.resize('nonexistent', 100, 40)).toThrow('PTY not found')
  })

  it('get returns undefined for unknown id', () => {
    expect(mgr.get('nonexistent')).toBeUndefined()
  })

  it('dispose kills all PTY sessions', () => {
    mgr.create({ cwd: '/tmp' })
    mgr.create({ cwd: '/tmp' })
    mgr.dispose()
    expect(mgr.list()).toHaveLength(0)
  })
})

describe('detectShell', () => {
  // detectShell 优先级链：process.env.SHELL → userInfo().shell → /bin/bash。
  // 回归 bug：SHELL 未导出到环境时，server 错误回退到 /bin/bash。
  const savedShell = process.env.SHELL

  afterEach(() => {
    if (savedShell === undefined) delete process.env.SHELL
    else process.env.SHELL = savedShell
  })

  it('process.env.SHELL 存在时优先使用', () => {
    process.env.SHELL = '/usr/bin/zsh'
    expect(detectShell()).toBe('/usr/bin/zsh')
  })

  it('process.env.SHELL 缺失时 fallback 到 userInfo().shell（/etc/passwd 登录 shell）', () => {
    delete process.env.SHELL
    expect(detectShell()).toBe(userInfo().shell)
    // 不应错误回退到硬编码 /bin/bash（除非用户登录 shell 真是 bash）
    expect(detectShell()).not.toBe('/bin/bash')
  })
})
