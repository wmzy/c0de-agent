// src/server/terminal/pty-manager.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PTYManager } from './pty-manager.js'

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
