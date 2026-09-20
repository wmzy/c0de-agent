import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolContext } from '../../shared/types/tool.js'
import { bashTool } from './bash.js'

let workDir: string
let ctx: ToolContext

beforeEach(async () => {
  workDir = join(tmpdir(), `bash-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(workDir, { recursive: true })
  ctx = {
    cwd: workDir,
    session: { id: 's1', cwd: workDir },
    abort: new AbortController().signal,
  }
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe('bashTool', () => {
  it('executes a simple command', async () => {
    const result = await bashTool.execute({ command: 'echo hello' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('hello')
    }
  })

  it('captures stdout and stderr', async () => {
    const result = await bashTool.execute({ command: 'echo out; echo err >&2' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('out')
      expect(result.output).toContain('err')
    }
  })

  it('uses custom cwd', async () => {
    await mkdir(join(workDir, 'sub'), { recursive: true })
    const result = await bashTool.execute({ command: 'pwd', cwd: join(workDir, 'sub') }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('sub')
    }
  })

  // 回归：cwd 参数此前直接 resolve(ctx.cwd, cwd)，绝对路径或 ../ 可逃逸工作目录——
  // 与 glob/grep 的 path 参数同型漏洞（f5d26a0 已修那两处，此处是漏网实例）。
  // permission 为 ask，但用户偏好可把 bash 设成 auto（或批量确认时看漏 cwd），
  // 逃逸后命令在工作目录外执行（如读取 ~/.ssh），与 read/write/edit 同口径收紧。
  it('rejects a cwd that escapes the working directory via ..', async () => {
    const result = await bashTool.execute({ command: 'pwd', cwd: join('..', 'escape') }, ctx)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('escapes the working directory')
    }
  })

  it('rejects an absolute cwd outside the working directory', async () => {
    const outside = join(tmpdir(), `bash-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(outside, { recursive: true })
    try {
      const result = await bashTool.execute({ command: 'pwd', cwd: outside }, ctx)
      expect(result._tag).toBe('error')
      if (result._tag === 'error') {
        expect(result.error).toContain('escapes the working directory')
      }
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('returns error for non-zero exit code', async () => {
    const result = await bashTool.execute({ command: 'exit 1' }, ctx)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('exit code: 1')
    }
  })

  it('respects env vars', async () => {
    const result = await bashTool.execute(
      { command: 'echo $MY_VAR', env: { MY_VAR: 'test123' } },
      ctx,
    )
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('test123')
    }
  })

  it('respects timeout', async () => {
    const result = await bashTool.execute({ command: 'sleep 10', timeout: 100 }, ctx)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error.toLowerCase()).toContain('timeout')
    }
  })

  it('handles abort signal', async () => {
    const ac = new AbortController()
    const abortCtx: ToolContext = {
      cwd: workDir,
      session: { id: 's1', cwd: workDir },
      abort: ac.signal,
    }
    // Start a long-running command, abort after 50ms
    const promise = bashTool.execute({ command: 'sleep 5' }, abortCtx)
    setTimeout(() => ac.abort(), 50)
    const result = await promise
    expect(result._tag).toBe('error')
  })

  it('includes exit code in metadata', async () => {
    const result = await bashTool.execute({ command: 'true' }, ctx)
    expect(result._tag).toBe('success')
    if (result._tag === 'success' && result.metadata) {
      expect(result.metadata.exitCode).toBe(0)
    }
  })

  it('has correct tool definition', () => {
    expect(bashTool.name).toBe('bash')
    expect(bashTool.permission).toBe('ask')
  })
})
