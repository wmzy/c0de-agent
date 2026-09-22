import { type ChildProcess, spawn } from 'node:child_process'
import { MAX_TIMER_MS } from '../../shared/timer.js'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import { safeResolve } from '../../shared/utils/path.js'
import { headChars } from '../../shared/utils/string.js'
import type { BashInput } from '../types.js'

/** Default timeout: 120 seconds. */
const DEFAULT_TIMEOUT = 120_000

/** stdout/stderr 各自捕获上限（字符）：命令输出在此之上的部分被丢弃并计数。
 *  截断发生在命令运行期而非 close 之后——executor 的 truncateOutput 只能在
 *  close 后裁剪，救不了累积期内存膨胀（`yes`/`find /` 几秒即可输出数 GB）。
 *  256KB 留足 executor 的 head+tail 截断预算（默认 maxChars 100k）。 */
const MAX_OUTPUT_CHARS = 256 * 1024

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
    // 同理，>2^31-1 的超大值（如 2^31）会被引擎钳到 1ms（TimeoutOverflowWarning）
    // 而非「超长等待」——同样显式拒绝，上限即 Node timer 的 32 位安全上限。
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMER_MS) {
      return {
        _tag: 'error',
        error: `bash: timeout must be a positive integer (milliseconds, max ${MAX_TIMER_MS}), got ${timeout}`,
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
      let droppedChars = 0
      let timedOut = false

      /** 追加捕获并执行字符上限：超限部分丢弃计数，绝不无界累积。
       *  切点经 headChars 内收，不产出孤立代理码元。 */
      const appendCapped = (target: 'stdout' | 'stderr', s: string): void => {
        const current = target === 'stdout' ? stdout : stderr
        if (current.length >= MAX_OUTPUT_CHARS) {
          droppedChars += s.length
          return
        }
        const next = current + s
        if (next.length > MAX_OUTPUT_CHARS) {
          droppedChars += next.length - MAX_OUTPUT_CHARS
        }
        if (target === 'stdout') {
          stdout = headChars(next, MAX_OUTPUT_CHARS)
        } else {
          stderr = headChars(next, MAX_OUTPUT_CHARS)
        }
      }

      // setEncoding('utf8') 让流内 StringDecoder 缓冲跨 chunk 的多字节序列：
      // 此前按 chunk 逐个 Buffer.toString() 解码，UTF-8 序列被拆成两片时产出
      // U+FFFD（如中文/emoji 输出静默损坏）。与 MCP/DAP transport 同口径。
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (data: string) => {
        appendCapped('stdout', data)
      })
      child.stderr?.on('data', (data: string) => {
        appendCapped('stderr', data)
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

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer)
        ctx.abort.removeEventListener('abort', onAbort)

        if (ctx.abort.aborted) {
          resolvePromise({ _tag: 'error', error: 'Command aborted by user' })
          return
        }

        if (timedOut) {
          resolvePromise({
            _tag: 'error',
            error: `Command timeout after ${timeout}ms\nPartial output:\n${stdout}${stderr}${
              droppedChars > 0 ? `\n[... ${droppedChars} chars of output dropped ...]` : ''
            }`,
          })
          return
        }

        const output = stdout + (stderr ? `\n${stderr}` : '')

        // 信号终止（code=null + signal 携带真实信号）：OOM killer / cgroup 限额 /
        // 外部 kill / 命令自杀都走这里。此前只看 code——null 落进成功分支，工具
        // 回 success 且 metadata.exitCode = code ?? 0 = 0，模型据此以为命令已跑完
        //（如构建被 SIGKILL 后继续用半成品产物）。
        if (signal !== null) {
          resolvePromise({
            _tag: 'error',
            error: `Command killed by signal ${signal}\n${output}${
              droppedChars > 0 ? `\n[... ${droppedChars} chars of output dropped ...]` : ''
            }`,
          })
          return
        }

        if (code !== null && code !== 0) {
          resolvePromise({
            _tag: 'error',
            error: `Command failed with exit code: ${code}\n${output}${
              droppedChars > 0 ? `\n[... ${droppedChars} chars of output dropped ...]` : ''
            }`,
          })
          return
        }

        resolvePromise({
          _tag: 'success',
          output:
            output +
              (droppedChars > 0 ? `\n[... ${droppedChars} chars of output dropped ...]` : '') ||
            '(no output)',
          metadata: {
            exitCode: code ?? 0,
            ...(droppedChars > 0 ? { droppedOutputChars: droppedChars } : {}),
          },
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
