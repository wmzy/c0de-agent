import { describe, expect, it } from 'vitest'
import { ADAPTER_COMMANDS, createDebugSpawn, resolveAdapterCommand } from './spawn.js'

describe('resolveAdapterCommand', () => {
  it('maps known adapter ids to their spawn commands', () => {
    expect(resolveAdapterCommand('node')).toEqual(ADAPTER_COMMANDS.node)
    expect(resolveAdapterCommand('python')[0]).toBe('python3')
    expect(resolveAdapterCommand('go')[0]).toBe('dlv')
    expect(resolveAdapterCommand('lldb')[0]).toBe('lldb-dap')
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
})
