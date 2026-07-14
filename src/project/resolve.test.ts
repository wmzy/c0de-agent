import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendToGitignore, checkIgnored, getGitLastCommit, resolveProject } from './resolve.js'

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

  it.runIf(hasGit)('git directory: id from worktree, remote recorded as metadata', () => {
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
    // same id whether resolved from root or subdir (worktree-based)
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

  it.runIf(hasGit)('git repo id 不随 remote 变更漂移（回归：先无 remote 后加 origin）', () => {
    const repo = join(tmpRoot, 'drift')
    mkdirSync(repo)
    execSync('git init -q', { cwd: repo })
    execSync('git checkout -q -b main', { cwd: repo })

    const before = resolveProject(repo)
    // 模拟「先无 remote 注册、后加 origin」——旧实现这里 id 会从 hash(worktree) 漂到 hash(remote)
    execSync('git remote add origin https://github.com/u/drift.git', { cwd: repo })
    const after = resolveProject(repo)

    expect(after.id).toBe(before.id)
    expect(after.gitRemote).toBe('https://github.com/u/drift.git')
  })
})

describe('checkIgnored', () => {
  it.runIf(hasGit)('返回被 .gitignore 覆盖的路径', () => {
    const repo = mkdtempSync(join(tmpdir(), 'c0de-chkign-'))
    execSync('git init -q', { cwd: repo })
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n*.log\n.c0de\n')

    const result = checkIgnored(repo, ['node_modules', 'app.ts', 'error.log', '.c0de', 'README.md'])
    expect(result.has('node_modules')).toBe(true)
    expect(result.has('error.log')).toBe(true)
    expect(result.has('.c0de')).toBe(true)
    expect(result.has('app.ts')).toBe(false)
    expect(result.has('README.md')).toBe(false)
  })

  it.runIf(hasGit)('空路径列表返回空集', () => {
    const repo = mkdtempSync(join(tmpdir(), 'c0de-chkign-empty-'))
    execSync('git init -q', { cwd: repo })
    expect(checkIgnored(repo, [])).toEqual(new Set())
  })

  it('非 git 目录返回空集', () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-nongit-'))
    expect(checkIgnored(dir, ['any.txt'])).toEqual(new Set())
  })
})

describe('appendToGitignore', () => {
  it.runIf(hasGit)('追加新条目到已有 .gitignore', () => {
    const repo = mkdtempSync(join(tmpdir(), 'c0de-appendgi-'))
    execSync('git init -q', { cwd: repo })
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n*.log\n')

    appendToGitignore(repo, ['.env', 'dist/'])

    const content = readFileSync(join(repo, '.gitignore'), 'utf-8')
    expect(content).toContain('node_modules')
    expect(content).toContain('.env')
    expect(content).toContain('dist/')
  })

  it.runIf(hasGit)('跳过已存在的条目（去重）', () => {
    const repo = mkdtempSync(join(tmpdir(), 'c0de-appendgi-dedup-'))
    execSync('git init -q', { cwd: repo })
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n*.log\n')

    appendToGitignore(repo, ['node_modules', '.env'])

    const content = readFileSync(join(repo, '.gitignore'), 'utf-8')
    expect(content.match(/node_modules/g)?.length).toBe(1)
    expect(content).toContain('.env')
  })

  it.runIf(hasGit)('.gitignore 不存在时创建新文件', () => {
    const repo = mkdtempSync(join(tmpdir(), 'c0de-appendgi-new-'))
    execSync('git init -q', { cwd: repo })

    appendToGitignore(repo, ['.env', 'dist/'])

    const content = readFileSync(join(repo, '.gitignore'), 'utf-8')
    expect(content).toContain('.env')
    expect(content).toContain('dist/')
  })

  it.runIf(hasGit)('所有条目都已存在时不修改文件', () => {
    const repo = mkdtempSync(join(tmpdir(), 'c0de-appendgi-noop-'))
    execSync('git init -q', { cwd: repo })
    const original = 'node_modules\n*.log\n'
    writeFileSync(join(repo, '.gitignore'), original)

    appendToGitignore(repo, ['node_modules', '*.log'])

    const content = readFileSync(join(repo, '.gitignore'), 'utf-8')
    expect(content).toBe(original)
  })
})

describe('getGitLastCommit', () => {
  it.runIf(hasGit)('返回最后一次提交的 subject/hash/author/date', () => {
    const repo = mkdtempSync(join(tmpdir(), 'c0de-lastcommit-'))
    execSync('git init -q', { cwd: repo })
    execSync('git config user.email test@test.com', { cwd: repo })
    execSync('git config user.name Tester', { cwd: repo })
    writeFileSync(join(repo, 'a.txt'), 'x')
    execSync('git add . && git commit -q -m "feat: init project"', { cwd: repo })

    const result = getGitLastCommit(repo)
    expect(result).not.toBeNull()
    expect(result!.subject).toBe('feat: init project')
    expect(result!.author).toBe('Tester')
    expect(result!.hash).toMatch(/^[0-9a-f]{7,}$/)
    expect(result!.date).toBeTruthy()
  })

  it('非 git 目录返回 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-lastcommit-nogit-'))
    expect(getGitLastCommit(dir)).toBeNull()
  })

  it.runIf(hasGit)('无提交的全新仓库返回 null', () => {
    const repo = mkdtempSync(join(tmpdir(), 'c0de-lastcommit-empty-'))
    execSync('git init -q', { cwd: repo })
    execSync('git config user.email test@test.com', { cwd: repo })
    execSync('git config user.name Tester', { cwd: repo })
    expect(getGitLastCommit(repo)).toBeNull()
  })
})
