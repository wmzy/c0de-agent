import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { safeResolve } from './path.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'safe-path-root-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('safeResolve', () => {
  it('resolves a relative path inside root to an absolute path', () => {
    expect(safeResolve(root, 'a/b.txt')).toBe(join(root, 'a/b.txt'))
  })

  it('resolves "." to root itself', () => {
    expect(safeResolve(root, '.')).toBe(root)
  })

  it('accepts an absolute path that falls inside root', () => {
    expect(safeResolve(root, join(root, 'nested/file.ts'))).toBe(join(root, 'nested/file.ts'))
  })

  it('rejects a relative path that escapes root via ..', () => {
    expect(safeResolve(root, '../../../etc/passwd')).toBeNull()
    expect(safeResolve(root, '../escape.txt')).toBeNull()
  })

  it('rejects an absolute path outside root', () => {
    expect(safeResolve(root, '/etc/passwd')).toBeNull()
    expect(safeResolve(root, '/')).toBeNull()
  })

  it('rejects a path whose relative form starts with ..', () => {
    // /tmp itself is a parent of the root temp dir → escape
    expect(safeResolve(root, tmpdir())).toBeNull()
  })

  it('rejects symlink escaping root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'safe-path-out-'))
    try {
      mkdirSync(join(root, 'sub'))
      symlinkSync(outside, join(root, 'sub', 'link'))
      expect(safeResolve(root, 'sub/link/secret.txt')).toBeNull()
      expect(safeResolve(root, 'sub/link')).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('allows symlink staying inside root', () => {
    mkdirSync(join(root, 'real'), { recursive: true })
    mkdirSync(join(root, 'sub'))
    symlinkSync(join(root, 'real'), join(root, 'sub', 'alias'))
    expect(safeResolve(root, 'sub/alias/file.txt')).toBe(join(root, 'sub/alias/file.txt'))
  })
})
