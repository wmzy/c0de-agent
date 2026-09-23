import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendToGitignore,
  checkIgnored,
  checkoutGitBranch,
  createGitBranch,
  getGitLastCommit,
  getGitStatus,
  isValidBranchName,
  resolveProject,
} from './resolve.js'

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
    expect(result?.subject).toBe('feat: init project')
    expect(result?.author).toBe('Tester')
    expect(result?.hash).toMatch(/^[0-9a-f]{7,}$/)
    expect(result?.date).toBeTruthy()
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

describe('getGitStatus', () => {
  it.runIf(hasGit)('modified/untracked/staged 分类映射', () => {
    const repo = mkdtempSync(join(tmpdir(), 'c0de-gitstatus-basic-'))
    execSync('git init -q', { cwd: repo })
    execSync('git config user.email test@test.com', { cwd: repo })
    execSync('git config user.name Tester', { cwd: repo })
    writeFileSync(join(repo, 'a.txt'), 'v1')
    execSync('git add . && git commit -q -m init', { cwd: repo })

    // modified
    writeFileSync(join(repo, 'a.txt'), 'v2')
    // untracked
    writeFileSync(join(repo, 'new.txt'), 'x')
    // staged
    writeFileSync(join(repo, 's.txt'), 'x')
    execSync('git add s.txt', { cwd: repo })

    const status = getGitStatus(repo)
    expect(status?.['a.txt']).toBe('modified')
    expect(status?.['new.txt']).toBe('untracked')
    expect(status?.['s.txt']).toBe('staged')
  })

  // 回归：porcelain v1 -z 的重命名输出是 "XY newpath\0oldpath\0"——第一字段
  // 携带新路径、第二字段为旧路径。此前把状态挂到 tokens[i+1]（旧路径）并
  // 跳过新路径：git mv 后新文件在文件树中无任何状态标记，且 map 中出现
  // 一个指向已不存在路径的幽灵条目。
  it.runIf(hasGit)('rename attaches status to the NEW path, not the old path', () => {
    const repo = mkdtempSync(join(tmpdir(), 'c0de-gitstatus-rename-'))
    execSync('git init -q', { cwd: repo })
    execSync('git config user.email test@test.com', { cwd: repo })
    execSync('git config user.name Tester', { cwd: repo })
    writeFileSync(join(repo, 'old.txt'), 'a')
    execSync('git add . && git commit -q -m init', { cwd: repo })
    execSync('git mv old.txt new.txt', { cwd: repo })

    const status = getGitStatus(repo)
    expect(status?.['new.txt']).toBe('staged')
    expect(status?.['old.txt']).toBeUndefined()
    expect(Object.keys(status ?? {})).toEqual(['new.txt'])
  })
})

describe('git 分支名参数注入', () => {
  const head = (repo: string): string =>
    execSync('git rev-parse --abbrev-ref HEAD', { cwd: repo }).toString().trim()
  const rev = (repo: string, ref: string): string =>
    execSync(`git rev-parse ${ref}`, { cwd: repo }).toString().trim()

  function initRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), 'c0de-branch-'))
    execSync('git init -q -b main', { cwd: repo })
    execSync('git config user.email test@test.com', { cwd: repo })
    execSync('git config user.name Tester', { cwd: repo })
    writeFileSync(join(repo, 'a.txt'), 'v1')
    execSync('git add . && git commit -q -m init', { cwd: repo })
    return repo
  }

  // 复现：checkoutGitBranch 把分支名作为**位置参数**传给 git checkout——
  // 以 `-` 开头的名字被 git 当作选项解析。`-Bfeature` 等价 `git checkout -B
  // feature`：把已存在的 feature 分支指针重置到当前 HEAD（该分支上的提交
  // 从分支历史中消失，只能靠 reflog 找回），且接口照常回成功。
  it.runIf(hasGit)('拒绝以 - 开头的分支名（-B<name> 会静默重置分支指针）', () => {
    const repo = initRepo()
    execSync('git checkout -q -b feature', { cwd: repo })
    writeFileSync(join(repo, 'f.txt'), 'f')
    execSync('git add . && git commit -q -m feature-commit', { cwd: repo })
    execSync('git checkout -q main', { cwd: repo })
    const featureBefore = rev(repo, 'feature')
    expect(featureBefore).not.toBe(rev(repo, 'main'))

    const result = checkoutGitBranch(repo, '-Bfeature')

    expect('error' in result).toBe(true)
    // 分支指针未被重置、HEAD 未切换、无分支被创建
    expect(rev(repo, 'feature')).toBe(featureBefore)
    expect(head(repo)).toBe('main')
  })

  it.runIf(hasGit)('拒绝 --detach 等被当作选项的名字（HEAD 不得脱离分支）', () => {
    const repo = initRepo()
    const result = checkoutGitBranch(repo, '--detach')
    expect('error' in result).toBe(true)
    expect(head(repo)).toBe('main')
  })

  it.runIf(hasGit)('拒绝非法 ref 名（空格/../~/:/^/*/[/\\）并给出明确错误', () => {
    const repo = initRepo()
    for (const bad of ['a b', 'a..b', 'a~1', 'a^', 'a:b', 'a*', 'a[b', 'a\\b', '.hidden', 'a/']) {
      const result = checkoutGitBranch(repo, bad)
      expect('error' in result, `应拒绝 "${bad}"`).toBe(true)
      expect((result as { error: string }).error).toContain('Invalid branch name')
    }
    // 未产生任何副作用：仍在 main、无新分支
    expect(head(repo)).toBe('main')
  })

  it.runIf(hasGit)('合法分支名照常切换', () => {
    const repo = initRepo()
    execSync('git branch fix-123', { cwd: repo })
    const result = checkoutGitBranch(repo, 'fix-123')
    expect('error' in result).toBe(false)
    expect(head(repo)).toBe('fix-123')
  })

  it.runIf(hasGit)('createGitBranch 同样拒绝以 - 开头的名字（不把 git stderr 当结果）', () => {
    const repo = initRepo()
    const result = createGitBranch(repo, '-Bmain')
    expect('error' in result).toBe(true)
    expect((result as { error: string }).error).toContain('Invalid branch name')
    expect(head(repo)).toBe('main')
    // 合法名照常创建并切换
    const ok = createGitBranch(repo, 'feature-x')
    expect('error' in ok).toBe(false)
    expect(head(repo)).toBe('feature-x')
  })

  it('isValidBranchName：拒绝注入与非法 ref，接受常规分支名', () => {
    for (const bad of [
      '-Bmain',
      '--detach',
      '-f',
      '',
      ' ',
      'a b',
      'a..b',
      'a~1',
      'a^',
      'a:b',
      'a*',
      'a[b',
      'a\\b',
      '.hidden',
      'a/',
      'a//b',
      'a@{b',
      '@',
      'a.lock',
      'a\nb',
    ]) {
      expect(isValidBranchName(bad), `应拒绝 ${JSON.stringify(bad)}`).toBe(false)
    }
    for (const good of [
      'main',
      'fix-123',
      'feature/x',
      'release/v1.2.3',
      'user/foo_bar',
      'v1.0.0-rc.1',
    ]) {
      expect(isValidBranchName(good), `应接受 ${good}`).toBe(true)
    }
  })
})
