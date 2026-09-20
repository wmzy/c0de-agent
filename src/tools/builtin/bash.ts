import { type ChildProcess, spawn } from 'node:child_process'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import { safeResolve } from '../../shared/utils/path.js'
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
      timeout: { type: 'integer', description: 'Timeout in milliseconds (default: 120000).' },
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
    // setTimeout 把 0/负数/Infinity（1e999）/NaN 全部钳到 ~1ms——命令刚 spawn
    // 即被杀，模型收到「timeout after Infinityms」这类误导性错误，无法区分
    // 「自己传了非法值」与「命令真超时」。显式报错供自纠。
    if (!Number.isInteger(timeout) || timeout < 1) {
      return {
        _tag: 'error',
        error: `bash: timeout must be a positive integer (milliseconds), got ${timeout}`,
      }
    }
    // 与 read/write/edit/glob/grep 同口径：cwd 必须落在工作目录内。此前直接
    // resolve(ctx.cwd, cwd) 放行绝对路径/../——bash 是任意命令执行面，越界即
    // 在工作目录外执行（如读取 ~/.ssh），且用户偏好可将 bash 设为 auto。
    let workDir = ctx.cwd
    if (cwd) {
      const resolved = safeResolve(ctx.cwd, cwd)
      if (resolved === null) {
        return { _tag: 'error', error: `cwd "${cwd}" escapes the working directory` }
      }
      workDir = resolved
    }

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
