import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveProject } from './resolve.js'

const hasGit = (() => {
  try {
    execSync('git --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'c0de-proj-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('resolveProject', () => {
  it('non-git directory: id from path hash, vcs null', () => {
    const dir = join(tmpRoot, 'plain')
    mkdirSync(dir)
    const result = resolveProject(dir)
    expect(result.vcs).toBeNull()
    expect(result.gitRemote).toBeNull()
    expect(result.gitBranch).toBeNull()
    expect(result.id).toHaveLength(16)
    expect(result.worktree).toBe(dir)
  })

  it('same non-git directory resolves to same id (deterministic)', () => {
    const dir = join(tmpRoot, 'plain2')
    mkdirSync(dir)
    const a = resolveProject(dir)
    const b = resolveProject(dir)
    expect(a.id).toBe(b.id)
  })

  it.runIf(hasGit)('git directory: id from remote, vcs git', () => {
    const repo = join(tmpRoot, 'repo')
    mkdirSync(repo)
    execSync('git init -q', { cwd: repo })
    execSync('git remote add origin https://github.com/u/repo.git', { cwd: repo })
    execSync('git checkout -q -b main', { cwd: repo })
    writeFileSync(join(repo, 'a.txt'), 'x')
    execSync('git add . && git -c user.email=a@b.c -c user.name=x commit -q -m init', { cwd: repo })

    const result = resolveProject(repo)
    expect(result.vcs).toBe('git')
    expect(result.gitRemote).toBe('https://github.com/u/repo.git')
    expect(result.gitBranch).toBe('main')
    expect(result.worktree).toBe(repo)
  })

  it.runIf(hasGit)('nested subdir resolves to repo root', () => {
    const repo = join(tmpRoot, 'repo2')
    mkdirSync(repo)
    execSync('git init -q', { cwd: repo })
    execSync('git remote add origin https://github.com/u/repo2.git', { cwd: repo })
    const sub = join(repo, 'src', 'deep')
    mkdirSync(sub, { recursive: true })

    const result = resolveProject(sub)
    expect(result.worktree).toBe(repo)
    expect(result.vcs).toBe('git')
    // same id whether resolved from root or subdir (remote-based)
    expect(result.id).toBe(resolveProject(repo).id)
  })

  it.runIf(hasGit)('git without remote: id from worktree path', () => {
    const repo = join(tmpRoot, 'norelote')
    mkdirSync(repo)
    execSync('git init -q', { cwd: repo })

    const result = resolveProject(repo)
    expect(result.vcs).toBe('git')
    expect(result.gitRemote).toBeNull()
    expect(result.id).toHaveLength(16)
    // differs from a plain non-git dir id only by content, length is 16
    expect(result.id).toBe(resolveProject(repo).id)
  })
})
