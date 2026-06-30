import { execSync } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyPatchToParent,
  captureBaseline,
  captureDeltaPatch,
  createWorktree,
} from './worktree.js'

let repoDir: string

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'c0de-git-'))
  execSync('git init -b main', { cwd: repoDir })
  execSync('git config user.email t@t.com && git config user.name t', { cwd: repoDir })
  await writeFile(join(repoDir, 'a.txt'), 'initial')
  execSync('git add . && git commit -m init', { cwd: repoDir })
})

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true })
})

describe('worktree isolation', () => {
  it('captureBaseline 记录 HEAD 和工作区状态', async () => {
    const baseline = await captureBaseline(repoDir)
    expect(baseline.headCommit).toMatch(/^[0-9a-f]+$/)
    expect(baseline.repoRoot).toBe(repoDir)
  })

  it('createWorktree 创建隔离工作树并返回路径', async () => {
    const wt = await createWorktree(repoDir, 'subagent-1')
    expect(wt).toContain('subagent-1')
    await expect(stat(wt)).resolves.toBeDefined()
  })

  it('captureDeltaPatch 计算 worktree 相对 baseline 的 diff', async () => {
    const baseline = await captureBaseline(repoDir)
    const wt = await createWorktree(repoDir, 'subagent-2')
    await writeFile(join(wt, 'a.txt'), 'modified')
    await writeFile(join(wt, 'b.txt'), 'new file')
    const patch = await captureDeltaPatch(wt, baseline)
    expect(patch).toContain('modified')
    expect(patch).toContain('new file')
  })

  it('applyPatchToParent 把 diff 应用回父仓库并 commit', async () => {
    const baseline = await captureBaseline(repoDir)
    const wt = await createWorktree(repoDir, 'subagent-3')
    await writeFile(join(wt, 'a.txt'), 'changed by agent')
    const patch = await captureDeltaPatch(wt, baseline)
    const result = await applyPatchToParent(repoDir, patch, 'agent(isolated): test')
    expect(result.commitSha).toMatch(/^[0-9a-f]+$/)
    const { readFile } = await import('node:fs/promises')
    const content = await readFile(join(repoDir, 'a.txt'), 'utf-8')
    expect(content).toBe('changed by agent')
  })
})
