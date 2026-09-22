import { describe, expect, it } from 'vitest'
import { createDebugSpawn, resolveAdapterCommand } from './spawn.js'

describe('resolveAdapterCommand', () => {
  it('maps known adapter ids to their spawn commands', () => {
    // node：显式断言包名与 --stdio 开关。此前映射到 npm 上不存在的
    // @vscode/js-debug（js-debug 只以 VS Code 扩展 / GitHub release 分发）——
    // npx 恒 404，node 调试起不来；改回不存在的包名会静默回归，故在此钉住。
    expect(resolveAdapterCommand('node')).toEqual([
      'npx',
      ['-y', '@bloopai/js-debug-adapter-stdio', '--stdio'],
    ])
    expect(resolveAdapterCommand('python')).toEqual(['python3', ['-m', 'debugpy.adapter']])
    expect(resolveAdapterCommand('go')).toEqual(['dlv', ['dap']])
    expect(resolveAdapterCommand('lldb')).toEqual(['lldb-dap', []])
  })

  it('treats unknown adapter ids as executable names', () => {
    expect(resolveAdapterCommand('my-adapter')).toEqual(['my-adapter', []])
  })
})

describe('createDebugSpawn', () => {
  it('spawns the mapped command and wraps stdio in a DAP transport', () => {
    const overrides: Record<string, [string, string[]]> = {
      test: ['echo', ['hi']],
    }
    const spawn = createDebugSpawn(overrides)
    const transport = spawn({ adapter: 'test', program: '/tmp/p' })
    // transport 提供 DAP 协议要求的四件套（stdio 包装）
    expect(typeof transport.write).toBe('function')
    expect(typeof transport.onData).toBe('function')
    expect(typeof transport.onClose).toBe('function')
    expect(typeof transport.close).toBe('function')
    transport.close()
  })

  it('falls back to the adapter id as command for unknown adapters', () => {
    const spawn = createDebugSpawn()
    // 未知 adapter 走「adapter 即命令」——进程大概率启动失败，但 spawn 本身不抛
    const transport = spawn({ adapter: '__definitely_not_a_real_binary__', program: '/tmp/p' })
    expect(transport).toBeTruthy()
    transport.close()
  })

  // 回归：调试器进程崩溃/提前 close(0) 后，transport.write 会异步触发 EPIPE
  // 'error' 事件；无监听器时 unhandled error 击穿宿主进程（与 MCP stdio 同型）。
  it('survives EPIPE when writing to a debug adapter whose stdin was closed', async () => {
    const script =
      'const fs=require("fs");fs.closeSync(0);process.stdout.write("READY\\n");setInterval(()=>{},1000)'
    const spawn = createDebugSpawn({ test: [process.execPath, ['-e', script]] })
    const transport = spawn({ adapter: 'test', program: '/tmp/p' })
    // 等子进程完成 closeSync(0)（真实子进程 + 真实 EPIPE）
    await new Promise((r) => setTimeout(r, 300))
    transport.write('initialize\n')
    // 给 EPIPE 'error' 事件留出派发窗口：修复前 unhandled error 在此窗口内击穿
    await new Promise((r) => setTimeout(r, 200))
    transport.close()
  })
})
