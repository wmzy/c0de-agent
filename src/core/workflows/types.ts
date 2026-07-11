/** 工作流元数据（脚本导出的 meta 对象）。 */
interface WorkflowMeta {
  /** 唯一标识，同时也是 slash 命令名。 */
  name: string
  /** 显示用描述。 */
  description: string
  /** 参数提示（如 '[扫描目标描述]'）。 */
  argsHint?: string
  /** 执行阶段标签（用于进度展示）。 */
  phases?: string[]
  /** 超时（秒），超时终止。 */
  timeout?: number
}

/** 工作流执行结果。 */
type WorkflowResult = {
  /** 人类可读总结（显示给用户）。 */
  output?: string
  /** 结构化数据（存档/程序化消费）。 */
  data?: unknown
}

/** 子 agent 返回结果（区分成功/失败）。 */
type WorkflowAgentResult =
  | { ok: true; output: string; data?: unknown }
  | { ok: false; error: string }

/** 工作流内置工具集（受限文件系统操作）。 */
interface WorkflowUtils {
  glob: (pattern: string) => Promise<string[]>
  grep: (
    pattern: string,
    path?: string,
  ) => Promise<Array<{ path: string; line: number; text: string }>>
  read: (filePath: string, range?: { start: number; end: number }) => Promise<string>
  splitByDirectory: (
    rootDir: string,
    opts?: { depth?: number; ignore?: string[] },
  ) => Promise<Array<{ name: string; path: string; files: string[] }>>
}

/** 工作流上下文（注入给脚本 default 函数的参数）。 */
interface WorkflowContext {
  /** 项目信息。 */
  project: { rootDir: string; name: string; gitBranch?: string }
  /** 用户传入的参数字符串。 */
  args: string
  /** 派发单个子 agent。委托 runSubAgent。 */
  runSubagent: (
    type: string,
    params: { assignment: string; description?: string; model?: string },
  ) => Promise<WorkflowAgentResult>
  /** 批量并行派发子 agent。委托 runSubAgent，concurrency pool。 */
  runSubagents: (
    type: string,
    tasks: Array<{ assignment: string; description?: string; role?: string }>,
    context?: string,
  ) => Promise<WorkflowAgentResult[]>
  /** 进度上报（→ SSE → 前端）。 */
  progress: (message: string, detail?: unknown) => void
  /** 内置工具。 */
  utils: WorkflowUtils
}

/** 工作流脚本模块（dynamic import 后的形状）。 */
interface WorkflowModule {
  meta: WorkflowMeta
  default: (ctx: WorkflowContext) => Promise<WorkflowResult>
}

/** 注册表中的条目。 */
interface WorkflowEntry {
  meta: WorkflowMeta
  source: 'builtin' | 'user' | 'project'
  filePath?: string
  /** 执行器。 */
  execute: (ctx: WorkflowContext) => Promise<WorkflowResult>
  /** 源码文本（show 命令和编辑用）。 */
  sourceCode?: string
}

export type {
  WorkflowAgentResult,
  WorkflowContext,
  WorkflowEntry,
  WorkflowMeta,
  WorkflowModule,
  WorkflowResult,
  WorkflowUtils,
}
