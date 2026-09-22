import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { SubAgentRequest, SubAgentResult } from '../../shared/types/tool.js'
import { globToRegex } from '../../tools/builtin/glob.js'
import type { AgentDependencies, AgentState } from '../types.js'
import type { WorkflowAgentResult, WorkflowContext } from './types.js'

/** buildWorkflowContext 的参数。 */
type BuildContextOpts = {
  deps: AgentDependencies
  parent: AgentState
  args: string
  onProgress: (message: string, detail?: unknown) => void
  /** 项目名（从 ProjectInfo 传入）。 */
  projectName?: string
  /** 测试注入：覆盖内部 runSubAgent 调用。生产环境省略，走 deps 关联的 loop.runSubAgent。 */
  runSubAgentFn?: (request: SubAgentRequest) => Promise<SubAgentResult>
}

/** SubAgentResult → WorkflowAgentResult 映射。 */
function mapResult(result: SubAgentResult): WorkflowAgentResult {
  if (result._tag === 'success') {
    return { ok: true, output: result.output, data: result.data }
  }
  if (result._tag === 'error') {
    return { ok: false, error: result.error }
  }
  return { ok: false, error: 'subagent returned running (background not supported in workflows)' }
}

/** 构建 WorkflowContext，注入 runSubagent/utils/progress。 */
function buildWorkflowContext(opts: BuildContextOpts): WorkflowContext {
  const { deps, parent, args, onProgress, projectName, runSubAgentFn } = opts
  const rootDir = deps.cwd

  // 默认 runSubAgent：通过动态 import 避免循环依赖
  const doRunSubAgent =
    runSubAgentFn ??
    (async (request: SubAgentRequest) => {
      const { runSubAgent } = await import('../loop.js')
      return runSubAgent(deps as Parameters<typeof runSubAgent>[0], parent, request)
    })

  return {
    project: {
      rootDir,
      name: projectName ?? 'project',
    },
    args,

    runSubagent: async (type, params) => {
      const result = await doRunSubAgent({
        agentType: type,
        prompt: params.assignment,
        description: params.description,
        model: params.model,
      })
      return mapResult(result)
    },

    runSubagents: async (type, tasks, context) => {
      const { runSubAgents } = await import('../loop/subagent.js')
      const requests: SubAgentRequest[] = tasks.map((task) => ({
        agentType: type,
        prompt: task.assignment,
        ...(task.description ? { description: task.description } : {}),
        ...(task.role ? { role: task.role } : {}),
        ...(context ? { context } : {}),
      }))
      // 与 task 工具批量模式共用同一派发实现：并发上限取
      // config.agents.subagentConcurrency（此前本模块硬编码 3，配置项形同虚设），
      // 逐任务错误隔离与「结果顺序一致、无空洞」的契约同源。
      const results = await runSubAgents(deps, parent, requests, doRunSubAgent)
      return results.map(mapResult)
    },

    progress: onProgress,

    utils: {
      glob: async (pattern: string) => {
        return globRecursive(rootDir, pattern)
      },

      grep: async (pattern: string, searchPath?: string) => {
        const baseDir = searchPath ? resolve(rootDir, searchPath) : rootDir
        return grepRecursive(baseDir, pattern, rootDir)
      },

      read: async (filePath: string, range?: { start: number; end: number }) => {
        const absPath = resolve(rootDir, filePath)
        const content = await readFile(absPath, 'utf-8')
        if (!range) return content
        // 与内置 read 工具同口径：range 未经校验直接进 slice(start - 1, end) 时
        // start=0 经 slice(-1, end) 静默返回文件最后一行（0 基/1 基错位的最坏
        // 形态）、小数行号被 slice 静默截断错行、end < start 静默空串——非法
        // range 显式抛错让工作流作者/模型自纠；end 超出行数收敛到末行（与
        // slice 语义一致）。
        const { start, end } = range
        if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start) {
          throw new Error(
            `utils.read: invalid range { start: ${start}, end: ${end} } — start/end 必须是整数，start >= 1 且 end >= start`,
          )
        }
        const lines = content.split('\n')
        return lines.slice(start - 1, end).join('\n')
      },

      splitByDirectory: async (dir: string, opts?: { depth?: number; ignore?: string[] }) => {
        return splitByDir(resolve(rootDir, dir), opts?.depth ?? 1, opts?.ignore ?? [])
      },
    },
  }
}

// ── 工具函数 ──

/**
 * 递归 glob。模式含路径分隔符时按相对路径匹配（双星号跨目录，如「src 下任意层级的 .ts」）；
 * 不含分隔符时按文件名匹配（与旧行为兼容：星号 .ts 命中任意层级）。
 * 模式翻译统一走 glob 工具的 globToRegex——此前本模块自带的翻译器不支持
 * 字符类/花括号（静默零命中），两处语义发散已收敛为单一实现。
 */
async function globRecursive(rootDir: string, pattern: string): Promise<string[]> {
  const results: string[] = []
  const regex = globToRegex(pattern)
  const matchRel = pattern.includes('/')

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else {
        const rel = relative(rootDir, fullPath)
        if (regex.test(matchRel ? rel : entry.name)) {
          results.push(rel)
        }
      }
    }
  }

  await walk(rootDir)
  return results
}

/** 递归 grep（正则搜索文件内容）。 */
async function grepRecursive(
  baseDir: string,
  pattern: string,
  rootDir: string,
): Promise<Array<{ path: string; line: number; text: string }>> {
  const results: Array<{ path: string; line: number; text: string }> = []
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  }

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else {
        try {
          const content = await readFile(fullPath, 'utf-8')
          const lines = content.split('\n')
          // CRLF 文件行尾 \r 使 ^...$ 锚定匹配恒失败（与内置 grep 工具同型）。
          const crlf = content.includes('\r\n')
          for (let i = 0; i < lines.length; i++) {
            const raw = lines[i]
            const line = crlf && raw?.endsWith('\r') ? raw.slice(0, -1) : raw
            if (line && regex.test(line)) {
              results.push({
                path: relative(rootDir, fullPath),
                line: i + 1,
                text: line.trim(),
              })
            }
          }
        } catch {
          // 二进制文件等，跳过
        }
      }
    }
  }

  await walk(baseDir)
  return results
}

/**
 * 按目录拆分模块。depth=N 时从 rootDir 向下走 N 层，每棵深度为 N 的子目录成为一个模块；
 * 深度不足 N 的叶子目录（没有子目录）也成为一个模块，避免被跳过。
 * 模块名 = 相对 rootDir 的路径（如 "src/a"）；rootDir 自身成为模块时命名为 "root"。
 */
async function splitByDir(
  rootDir: string,
  depth: number,
  ignore: string[],
): Promise<Array<{ name: string; path: string; files: string[] }>> {
  const modules: Array<{ name: string; path: string; files: string[] }> = []

  async function collectFiles(dir: string): Promise<string[]> {
    const files: string[] = []
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return files
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (ignore.includes(entry.name)) continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...(await collectFiles(fullPath)))
      } else {
        files.push(relative(rootDir, fullPath))
      }
    }
    return files
  }

  async function readSubdirs(dir: string): Promise<import('node:fs').Dirent[]> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    return entries.filter(
      (e) => e.isDirectory() && !e.name.startsWith('.') && !ignore.includes(e.name),
    )
  }

  async function pushModule(dir: string): Promise<void> {
    const rel = relative(rootDir, dir)
    modules.push({
      name: rel === '' ? 'root' : rel,
      path: dir,
      files: await collectFiles(dir),
    })
  }

  async function collectModules(currentDir: string, currentDepth: number): Promise<void> {
    // 到达目标深度：当前目录成为模块
    if (currentDepth >= depth) {
      await pushModule(currentDir)
      return
    }

    // 未到达目标深度：继续向下走
    const subdirs = await readSubdirs(currentDir)

    // 深度不足 N 的叶子目录（无子目录）：成为模块，避免被跳过
    if (subdirs.length === 0) {
      await pushModule(currentDir)
      return
    }

    for (const subdir of subdirs) {
      await collectModules(join(currentDir, subdir.name), currentDepth + 1)
    }
  }

  await collectModules(rootDir, 0)
  return modules
}

export { buildWorkflowContext }
