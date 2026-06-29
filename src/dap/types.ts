// DAP 类型（spec §21）。零依赖的最小子集。

/** 启动调试会话的配置。 */
type DAPConfig = {
  /** 调试适配器标识（如 'node', 'python'），用于 initialize.adapterID。 */
  adapter: string
  /** 被调试程序路径。 */
  program: string
  /** attach 或 launch（默认 launch）。 */
  request?: 'launch' | 'attach'
  args?: string[]
  cwd?: string
  /** 额外的 launch/attach 参数（适配器特定）。 */
  launchArgs?: Record<string, unknown>
}

/** 调试会话句柄。 */
type DAPSession = {
  id: string
  adapter: string
  program: string
  state: 'running' | 'paused' | 'stopped'
}

/** 断点。 */
type Breakpoint = {
  file: string
  line: number
  condition?: string
}

/** 栈帧。 */
type StackFrame = {
  id: number
  name: string
  file: string
  line: number
  column?: number
}

/** 变量。 */
type Variable = {
  name: string
  value: string
  type?: string
  variablesReference?: number
}

/** 工具用的简化配置（spec §21 debug_start 输入）。 */
type DebugStartInput = {
  adapter: string
  program: string
  args?: string[]
  cwd?: string
  stopOnEntry?: boolean
}

export type { Breakpoint, DAPConfig, DAPSession, DebugStartInput, StackFrame, Variable }
