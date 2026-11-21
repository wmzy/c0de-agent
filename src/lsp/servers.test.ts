import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findWorkspaceRoot, pickServersForFile, resolveBinary, resolveServers } from './servers.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'lsp-servers-'))
const prevPath = process.env.PATH

beforeEach(() => {
  process.env.PATH = prevPath
})

afterEach(() => {
  process.env.PATH = prevPath
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function noServers(): { lsp: { servers: Record<string, never> } } {
  return { lsp: { servers: {} } }
}

describe('resolveServers', () => {
  it('returns the builtin table by default', () => {
    const servers = resolveServers(noServers())
    const names = servers.map((s) => s.name)
    expect(names).toContain('typescript-language-server')
    expect(names).toContain('pyright')
    expect(names).toContain('gopls')
    expect(names).toContain('clangd')
    expect(names).toContain('rust-analyzer')
    const ts = servers.find((s) => s.name === 'typescript-language-server')
    expect(ts).toMatchObject({ command: 'typescript-language-server', args: ['--stdio'] })
    expect(ts?.fileTypes).toContain('tsx')
  })

  it('shallow-merges builtin overrides and drops disabled entries', () => {
    const servers = resolveServers({
      lsp: {
        servers: {
          gopls: { command: '/opt/gopls-custom', args: ['-mode=stdio'] },
          pyright: { disabled: true },
        },
      },
    })
    const gopls = servers.find((s) => s.name === 'gopls')
    expect(gopls).toMatchObject({ command: '/opt/gopls-custom', args: ['-mode=stdio'] })
    // 未提供的字段继承内置值。
    expect(gopls?.fileTypes).toEqual(['go'])
    expect(servers.find((s) => s.name === 'pyright')).toBeUndefined()
  })

  it('appends custom servers (command required) and skips commandless ones', () => {
    const servers = resolveServers({
      lsp: {
        servers: {
          zcustom: { command: 'zcustom-langserver', fileTypes: ['zc'] },
          broken: { fileTypes: ['bk'] },
          off: { command: 'x', disabled: true },
        },
      },
    })
    const custom = servers.find((s) => s.name === 'zcustom')
    expect(custom).toMatchObject({ command: 'zcustom-langserver', fileTypes: ['zc'] })
    expect(servers.find((s) => s.name === 'broken')).toBeUndefined()
    expect(servers.find((s) => s.name === 'off')).toBeUndefined()
  })
})

describe('pickServersForFile', () => {
  it('matches by extension and returns empty for unknown extensions', () => {
    const servers = resolveServers(noServers())
    expect(pickServersForFile(servers, '/x/src/a.ts').map((s) => s.name)).toEqual([
      'typescript-language-server',
    ])
    expect(pickServersForFile(servers, '/x/lib.h').map((s) => s.name)).toEqual(['clangd'])
    expect(pickServersForFile(servers, '/x/main.go')).toHaveLength(1)
    expect(pickServersForFile(servers, '/x/README')).toEqual([])
    expect(pickServersForFile(servers, '/x/noext')).toEqual([])
  })
})

describe('resolveBinary', () => {
  it('prefers <rootDir>/node_modules/.bin/<command>', () => {
    const root = join(tmpRoot, 'proj-local')
    const binDir = join(root, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    const bin = join(binDir, 'my-lsp-server')
    writeFileSync(bin, '#!/bin/sh\nexit 0\n')
    chmodSync(bin, 0o755)
    // PATH 里也有同名假可执行文件——node_modules/.bin 必须赢。
    const otherDir = join(tmpRoot, 'other-bin')
    mkdirSync(otherDir, { recursive: true })
    const other = join(otherDir, 'my-lsp-server')
    writeFileSync(other, '#!/bin/sh\nexit 1\n')
    chmodSync(other, 0o755)
    process.env.PATH = otherDir
    expect(resolveBinary('my-lsp-server', root)).toBe(bin)
  })

  it('falls back to PATH lookup', () => {
    const dir = join(tmpRoot, 'path-bin')
    mkdirSync(dir, { recursive: true })
    const bin = join(dir, 'path-lsp-server')
    writeFileSync(bin, '#!/bin/sh\nexit 0\n')
    chmodSync(bin, 0o755)
    process.env.PATH = join(tmpRoot, 'empty-ws')
    expect(resolveBinary('path-lsp-server', join(tmpRoot, 'empty-ws'))).toBe(null)
    process.env.PATH = dir
    expect(resolveBinary('path-lsp-server', join(tmpRoot, 'empty-ws'))).toBe(bin)
  })

  it('checks path-bearing commands directly', () => {
    const dir = join(tmpRoot, 'direct-bin')
    mkdirSync(dir, { recursive: true })
    const bin = join(dir, 'direct-server')
    writeFileSync(bin, '#!/bin/sh\nexit 0\n')
    chmodSync(bin, 0o755)
    process.env.PATH = ''
    expect(resolveBinary(bin, tmpRoot)).toBe(bin)
    expect(resolveBinary(join(dir, 'missing'), tmpRoot)).toBe(null)
  })
})

describe('findWorkspaceRoot', () => {
  it('walks up to the first directory containing a marker', () => {
    const root = join(tmpRoot, 'ws-root')
    const nested = join(root, 'a', 'b', 'c')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(root, 'package.json'), '{}')
    expect(findWorkspaceRoot(nested, ['package.json'])).toBe(root)
  })

  it('returns fromDir itself when no marker is found up to the fs root', () => {
    const dir = join(tmpRoot, 'ws-nomarker', 'sub')
    mkdirSync(dir, { recursive: true })
    // 用不可能存在于任何祖先目录的 marker 名，保证走到文件系统根。
    expect(findWorkspaceRoot(dir, ['c0de-no-such-marker-xyz'])).toBe(dir)
  })

  it('matches any of the markers', () => {
    const root = join(tmpRoot, 'ws-multi')
    const nested = join(root, 'deep')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(root, 'go.mod'), 'module x')
    expect(findWorkspaceRoot(nested, ['Cargo.toml', 'go.mod'])).toBe(root)
  })
})
