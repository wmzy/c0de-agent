// src/server/terminal/pty-manager.test.ts

import { userInfo } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { argvToCommand, detectShell, PTYManager } from './pty-manager.js'

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

  it('P1：create 接受指定 id（热更新快照恢复沿用原 id，前端布局无感重连）', () => {
    const info = mgr.create({ cwd: '/tmp', title: 'restored', id: 'pty_restored_1' })
    expect(info.id).toBe('pty_restored_1')
    expect(mgr.get('pty_restored_1')).toBeDefined()
    // 重复 create 同 id 返回既有条目，不泄漏/覆盖进程
    const again = mgr.create({ cwd: '/other', id: 'pty_restored_1' })
    expect(again.pid).toBe(info.pid)
    expect(mgr.list()).toHaveLength(1)
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

  it('P3-13：cols/rows 钳制到 [1, MAX]（负值与超大值不进入 spawn）', () => {
    const tiny = mgr.create({ cwd: '/tmp', cols: -5, rows: -10 })
    expect(tiny.cols).toBe(1)
    expect(tiny.rows).toBe(1)
    const huge = mgr.create({ cwd: '/tmp', cols: 100_000, rows: 90_000 })
    expect(huge.cols).toBeLessThanOrEqual(1000)
    expect(huge.rows).toBeLessThanOrEqual(500)
    // resize 同口径钳制
    mgr.resize(huge.id, 999_999, -1)
    expect(mgr.get(huge.id)?.cols).toBeLessThanOrEqual(1000)
    expect(mgr.get(huge.id)?.rows).toBe(1)
    mgr.kill(tiny.id)
    mgr.kill(huge.id)
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
  })
})

describe('argvToCommand（前台命令重放的安全转义）', () => {
  it('安全字符不额外加引号', () => {
    expect(argvToCommand(['npm', 'run', 'dev'])).toBe('npm run dev')
    expect(argvToCommand(['--port', '3000'])).toBe('--port 3000')
  })

  it('含空格参数用单引号包裹', () => {
    expect(argvToCommand(['echo', 'a b'])).toBe("echo 'a b'")
  })

  it('shell 元字符参数被引用（防重放时注入）', () => {
    expect(argvToCommand(['echo', 'a;b'])).toBe("echo 'a;b'")
    expect(argvToCommand(['bash', '-c', 'rm -rf /'])).toBe("bash -c 'rm -rf /'")
  })

  it('单引号参数按 POSIX 规则转义', () => {
    expect(argvToCommand(['printf', "it's"])).toBe("printf 'it'\\''s'")
  })

  it('空 argv 返回空串', () => {
    expect(argvToCommand([])).toBe('')
  })
})
