import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
    const result = await bashTool.execute(
      { command: 'sleep 10', timeout: 100 },
      ctx,
    )
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
