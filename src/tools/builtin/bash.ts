import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import type { BashInput } from '../types.js'

/** Default timeout: 120 seconds. */
const DEFAULT_TIMEOUT = 120_000

/** Kill an entire process tree (the child and all its descendants). */
function killProcessTree(child: ChildProcess): void {
  try {
    // On Linux/macOS, negative PID kills the process group.
    // We use `detached: true` at spawn to create a new process group.
    if (child.pid) {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {
    // Process may have already exited — ignore
  }
}

/**
 * bash tool: execute a shell command synchronously.
 * Permission: ask (can modify filesystem, run arbitrary code).
 *
 * Features:
 * - Merges stdout + stderr
 * - Process tree kill on abort
 * - Timeout kills the process tree
 * - Returns exit code in metadata
 */
export const bashTool: ToolDef = {
  name: 'bash',
  description:
    'Execute a shell command. Merges stdout+stderr. Supports custom cwd, env, and timeout (default 120s). Returns exit code in metadata.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute.' },
      cwd: { type: 'string', description: 'Working directory (default: ctx.cwd).' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 120000).' },
      env: {
        type: 'object',
        description: 'Additional environment variables.',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['command'],
  },
  permission: 'ask',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const { command, cwd, timeout = DEFAULT_TIMEOUT, env } = input as BashInput
    const workDir = cwd ? resolve(ctx.cwd, cwd) : ctx.cwd

    return new Promise<ToolResult>((resolvePromise) => {
      const childEnv = { ...process.env, ...env }

      const child = spawn(command, {
        cwd: workDir,
        shell: true,
        env: childEnv,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      // Timeout handler
      const timer = setTimeout(() => {
        timedOut = true
        killProcessTree(child)
      }, timeout)

      // Abort handler
      const onAbort = () => {
        clearTimeout(timer)
        killProcessTree(child)
      }
      if (ctx.abort.aborted) {
        killProcessTree(child)
        resolvePromise({ _tag: 'error', error: 'Operation aborted before execution' })
        return
      }
      ctx.abort.addEventListener('abort', onAbort, { once: true })

      child.on('close', (code: number | null) => {
        clearTimeout(timer)
        ctx.abort.removeEventListener('abort', onAbort)

        if (ctx.abort.aborted) {
          resolvePromise({ _tag: 'error', error: 'Command aborted by user' })
          return
        }

        if (timedOut) {
          resolvePromise({
            _tag: 'error',
            error: `Command timeout after ${timeout}ms\nPartial output:\n${stdout}${stderr}`,
          })
          return
        }

        const output = stdout + (stderr ? `\n${stderr}` : '')

        if (code !== null && code !== 0) {
          resolvePromise({
            _tag: 'error',
            error: `Command failed with exit code: ${code}\n${output}`,
          })
          return
        }

        resolvePromise({
          _tag: 'success',
          output: output || '(no output)',
          metadata: { exitCode: code ?? 0 },
        })
      })

      child.on('error', (err: Error) => {
        clearTimeout(timer)
        ctx.abort.removeEventListener('abort', onAbort)
        resolvePromise({
          _tag: 'error',
          error: `Failed to spawn command: ${err.message}`,
        })
      })
    })
  },
}
