// DAP 宿主接线（spec §21）：把调试适配器 id 映射为可 spawn 的命令，包装成
// DebugSpawn（session.ts 的依赖反转注入点）。此前无任何宿主注入 debugSpawn，
// debug_start 恒报「no debug adapter spawn is wired」——本模块就是缺的那块。
//
// 已知适配器映射（stdlib 命名的保守默认）：
//   node    → npx @vscode/js-debug --stdio（官方 JS 调试器，DAP over stdio，
//             首次使用经 npx 下载；js-debug 自己 spawn node --inspect）
//   python  → python3 -m debugpy.adapter（需 pip install debugpy）
//   go      → dlv dap（默认 stdio 模式）
//   lldb    → lldb-dap（LLDB DAP 前端）
// 未知 adapter id → 直接把 id 当作可执行命令名（如 "gdb" 的 DAP 包装器名），
// 允许用户通过自定义适配器命令扩展。

import type { DAPTransport } from './protocol.js'
import type { DebugSpawn } from './session.js'
import { createProcessTransport } from './transport.js'
import type { DAPConfig } from './types.js'

/** 已知适配器 → [command, args]。 */
const ADAPTER_COMMANDS: Record<string, [string, string[]]> = {
  node: ['npx', ['-y', '-p', '@vscode/js-debug', 'js-debug', '--stdio']],
  python: ['python3', ['-m', 'debugpy.adapter']],
  go: ['dlv', ['dap']],
  lldb: ['lldb-dap', []],
}

/** 解析适配器 id → spawn 命令（导出供测试）。 */
function resolveAdapterCommand(adapter: string): [string, string[]] {
  const known = ADAPTER_COMMANDS[adapter]
  if (known) return known
  return [adapter, []]
}

/**
 * 创建生产 DebugSpawn：按适配器映射 spawn 调试器进程，返回其 stdio 包装的
 * DAPTransport。`overrides` 允许测试/高级用户注入自定义映射。
 */
function createDebugSpawn(overrides?: Record<string, [string, string[]]>): DebugSpawn {
  return (config: DAPConfig): DAPTransport => {
    const map = overrides ?? ADAPTER_COMMANDS
    const [command, args] = map[config.adapter] ?? [config.adapter, []]
    const { transport } = createProcessTransport(command, args)
    return transport
  }
}

export { ADAPTER_COMMANDS, createDebugSpawn, resolveAdapterCommand }
