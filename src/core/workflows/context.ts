import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { SubAgentRequest, SubAgentResult } from '../../shared/types/tool.js'
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
      const { mapWithConcurrencyLimit } = await import('../agents/parallel.js')
      const concurrency = 3
      const { results } = await mapWithConcurrencyLimit(
        tasks,
        concurrency,
        async (task: { assignment: string; description?: string; role?: string }) => {
          const result = await doRunSubAgent({
            agentType: type,
            prompt: task.assignment,
            description: task.description,
            role: task.role,
            context,
          })
          return mapResult(result)
        },
      )
      return results.filter((r): r is WorkflowAgentResult => r !== undefined)
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
        const lines = content.split('\n')
        return lines.slice(range.start - 1, range.end).join('\n')
      },

      splitByDirectory: async (dir: string, opts?: { depth?: number; ignore?: string[] }) => {
        return splitByDir(resolve(rootDir, dir), opts?.depth ?? 1, opts?.ignore ?? [])
      },
    },
  }
}

// ── 工具函数 ──

/** 递归 glob（简单实现，匹配文件名后缀或通配符）。 */
async function globRecursive(rootDir: string, pattern: string): Promise<string[]> {
  const results: string[] = []
  const regex = new RegExp(pattern.replace(/\./g, '\\.').replace(/\*/g, '.*'))

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
      } else if (regex.test(entry.name)) {
        results.push(relative(rootDir, fullPath))
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
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
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

/** 按子目录拆分模块。 */
async function splitByDir(
  rootDir: string,
  _depth: number,
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

  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return modules
  }

  const subdirs = entries.filter(
    (e) => e.isDirectory() && !e.name.startsWith('.') && !ignore.includes(e.name),
  )

  if (subdirs.length === 0) {
    modules.push({ name: 'root', path: rootDir, files: await collectFiles(rootDir) })
    return modules
  }

  for (const subdir of subdirs) {
    const dirPath = join(rootDir, subdir.name)
    modules.push({
      name: subdir.name,
      path: dirPath,
      files: await collectFiles(dirPath),
    })
  }

  return modules
}

export { buildWorkflowContext }
