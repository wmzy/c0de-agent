import { encodeMessage } from '../../dap/protocol.js'
import { createDebugSessionManager, type DebugSpawn } from '../../dap/session.js'
import type { Breakpoint, DAPConfig, DebugStartInput } from '../../dap/types.js'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'

/**
 * debug_* 工具（spec §21）：暴露调试器能力给 agent。
 *
 * 依赖反转（同 task 工具）：调试适配器的 spawn 由 host 通过
 * `ctx.debugSpawn` 注入，本包不依赖 child_process，也不依赖 core。
 * 无注入时 debug_start 返回 error。
 *
 * 模块级 manager 持有活跃会话；sessionId 由 debug_start 返回，agent
 * 将其传给后续工具。
 */
const manager = createDebugSessionManager()

function ok(output: unknown): ToolResult {
  return {
    _tag: 'success',
    output: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
  }
}

function fail(message: string): ToolResult {
  return { _tag: 'error', error: message }
}

// debug_start — 启动调试会话（权限 ask：启动调试器是重操作）
const debugStartTool: ToolDef = {
  name: 'debug_start',
  description:
    'Start a debug session by launching a debug adapter and the target program. Returns { sessionId, threadId }. Other debug_* tools take the sessionId.',
  parameters: {
    type: 'object',
    properties: {
      adapter: { type: 'string', description: 'Debug adapter id, e.g. "node", "python".' },
      program: { type: 'string', description: 'Path to the program to debug.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Program arguments.' },
      cwd: { type: 'string', description: 'Working directory for the program.' },
      stopOnEntry: { type: 'boolean', description: 'Break on entry (default false).' },
    },
    required: ['adapter', 'program'],
  },
  permission: 'ask',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    if (!ctx.debugSpawn) {
      return fail('debug_start unavailable: no debug adapter spawn is wired into this context')
    }
    const i = input as DebugStartInput
    const config: DAPConfig = {
      adapter: i.adapter,
      program: i.program,
      args: i.args,
      cwd: i.cwd,
      launchArgs: { stopOnEntry: i.stopOnEntry ?? false },
    }
    try {
      const spawn = ctx.debugSpawn as DebugSpawn
      const result = await manager.start(spawn, config)
      return ok(result)
    } catch (error) {
      return fail(`debug_start failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

// debug_breakpoint — 设置断点（auto）
const debugBreakpointTool: ToolDef = {
  name: 'debug_breakpoint',
  description: 'Set a breakpoint at a file:line (optional condition).',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      file: { type: 'string' },
      line: { type: 'number' },
      condition: { type: 'string', description: 'Optional hit condition expression.' },
    },
    required: ['sessionId', 'file', 'line'],
  },
  permission: 'auto',
  execute: async (input: unknown): Promise<ToolResult> => {
    const { sessionId, file, line, condition } = input as {
      sessionId: string
      file: string
      line: number
      condition?: string
    }
    const bp: Breakpoint = { file, line, ...(condition ? { condition } : {}) }
    try {
      const result = await manager.setBreakpoint(sessionId, bp)
      return ok(result)
    } catch (error) {
      return fail(
        `debug_breakpoint failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  },
}

// debug_continue — 继续执行（auto）
const debugContinueTool: ToolDef = {
  name: 'debug_continue',
  description: 'Continue execution of the given thread until the next stop.',
  parameters: {
    type: 'object',
    properties: { sessionId: { type: 'string' }, threadId: { type: 'number' } },
    required: ['sessionId', 'threadId'],
  },
  permission: 'auto',
  execute: async (input: unknown): Promise<ToolResult> => {
    const { sessionId, threadId } = input as { sessionId: string; threadId: number }
    try {
      return ok(await manager.continue(sessionId, threadId))
    } catch (error) {
      return fail(
        `debug_continue failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  },
}

// debug_step — 单步 over/in/out（auto）
const debugStepTool: ToolDef = {
  name: 'debug_step',
  description: 'Step execution: kind = "over" | "in" | "out".',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      threadId: { type: 'number' },
      kind: { type: 'string', enum: ['over', 'in', 'out'] },
    },
    required: ['sessionId', 'threadId', 'kind'],
  },
  permission: 'auto',
  execute: async (input: unknown): Promise<ToolResult> => {
    const { sessionId, threadId, kind } = input as {
      sessionId: string
      threadId: number
      kind: 'over' | 'in' | 'out'
    }
    try {
      return ok(await manager.step(sessionId, threadId, kind))
    } catch (error) {
      return fail(`debug_step failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

// debug_stack — 调用栈（auto）
const debugStackTool: ToolDef = {
  name: 'debug_stack',
  description: 'Get the stack trace of a thread. Returns StackFrame[].',
  parameters: {
    type: 'object',
    properties: { sessionId: { type: 'string' }, threadId: { type: 'number' } },
    required: ['sessionId', 'threadId'],
  },
  permission: 'auto',
  execute: async (input: unknown): Promise<ToolResult> => {
    const { sessionId, threadId } = input as { sessionId: string; threadId: number }
    try {
      const frames = await manager.stack(sessionId, threadId)
      return ok(frames)
    } catch (error) {
      return fail(`debug_stack failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

// debug_vars — 查看变量（auto）
const debugVarsTool: ToolDef = {
  name: 'debug_vars',
  description:
    'Get variables visible in a stack frame (frameId from debug_stack). Returns Variable[].',
  parameters: {
    type: 'object',
    properties: { sessionId: { type: 'string' }, frameId: { type: 'number' } },
    required: ['sessionId', 'frameId'],
  },
  permission: 'auto',
  execute: async (input: unknown): Promise<ToolResult> => {
    const { sessionId, frameId } = input as { sessionId: string; frameId: number }
    try {
      const vars = await manager.variables(sessionId, frameId)
      return ok(vars)
    } catch (error) {
      return fail(`debug_vars failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

// debug_eval — 求值表达式（auto）
const debugEvalTool: ToolDef = {
  name: 'debug_eval',
  description: 'Evaluate an expression in the context of a stack frame. Returns the result string.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      frameId: { type: 'number' },
      expression: { type: 'string' },
    },
    required: ['sessionId', 'frameId', 'expression'],
  },
  permission: 'auto',
  execute: async (input: unknown): Promise<ToolResult> => {
    const { sessionId, frameId, expression } = input as {
      sessionId: string
      frameId: number
      expression: string
    }
    try {
      const result = await manager.evaluate(sessionId, frameId, expression)
      return ok(result)
    } catch (error) {
      return fail(`debug_eval failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

// debug_stop — 停止调试（auto）
const debugStopTool: ToolDef = {
  name: 'debug_stop',
  description: 'Stop the debug session and disconnect the adapter.',
  parameters: {
    type: 'object',
    properties: { sessionId: { type: 'string' } },
    required: ['sessionId'],
  },
  permission: 'auto',
  execute: async (input: unknown): Promise<ToolResult> => {
    const { sessionId } = input as { sessionId: string }
    try {
      await manager.stop(sessionId)
      return ok(`debug session ${sessionId} stopped`)
    } catch (error) {
      return fail(`debug_stop failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

const dapTools: ToolDef[] = [
  debugStartTool,
  debugBreakpointTool,
  debugContinueTool,
  debugStepTool,
  debugStackTool,
  debugVarsTool,
  debugEvalTool,
  debugStopTool,
]

// re-export for tests/host wiring
export {
  dapTools,
  debugBreakpointTool,
  debugContinueTool,
  debugEvalTool,
  debugStackTool,
  debugStartTool,
  debugStepTool,
  debugStopTool,
  debugVarsTool,
  encodeMessage,
  manager,
}
