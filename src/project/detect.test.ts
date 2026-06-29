import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectProjectInfo } from './detect.js'

describe('detectProjectInfo', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'c0de-detect-'))
  })

  afterEach(() => {
    // tmpdir 自带清理，无需手动删
  })

  it('reads name and framework from package.json', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'my-cool-app', dependencies: { react: '^19.0.0' } }),
    )
    const info = detectProjectInfo(dir)
    expect(info.name).toBe('my-cool-app')
    expect(info.framework).toBe('react')
  })

  it('infers language from .ts files', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const x = 1')
    writeFileSync(join(dir, 'src', 'b.ts'), 'export const y = 2')
    const info = detectProjectInfo(dir)
    expect(info.language).toBe('TypeScript')
  })

  it('detects git branch when in a git repo', () => {
    // 用本仓库自身作为 git repo（已是 git 仓库）
    const info = detectProjectInfo(process.cwd())
    expect(info.gitBranch).toBeTruthy()
    expect(typeof info.gitBranch).toBe('string')
  })

  it('falls back to safe defaults when package.json missing', () => {
    // dir 无 package.json、无 git
    const info = detectProjectInfo(dir)
    expect(info.name).toBe('project')
    expect(info.language).toBe('unknown')
    expect(info.framework).toBeUndefined()
    expect(info.rootDir).toBe(dir)
  })
})
