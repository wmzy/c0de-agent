import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { safeResolve } from './path.js'

const root = join(tmpdir(), `safe-path-root-${Date.now()}-${Math.random().toString(36).slice(2)}`)

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
})
