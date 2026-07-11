import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WorkflowEntry, WorkflowMeta, WorkflowModule, WorkflowSource } from './types.js'

/** 项目级工作流目录相对路径。 */
const PROJECT_WORKFLOWS_DIR = '.c0de/workflows'
/** 用户级（全局）工作流目录：~/.c0de/workflows。 */
const GLOBAL_WORKFLOWS_DIR = join('.c0de', 'workflows')

/**
 * 扫描指定目录下的 `*.js` 工作流文件，dynamic import 后转为 WorkflowEntry。
 * import 失败的文件跳过（warn），不阻塞其他工作流加载。
 *
 * 由 discoverWorkflows（projectDir）与 discoverGlobalWorkflows（~/.c0de/workflows）复用，
 * 仅 dirPath 与 source 字段不同。
 */
async function discoverFromDir(dirPath: string, source: WorkflowSource): Promise<WorkflowEntry[]> {
  const entries: WorkflowEntry[] = []

  let files: string[]
  try {
    const dirents = await readdir(dirPath)
    files = dirents.filter((f) => f.endsWith('.js'))
  } catch {
    // 目录不存在或不可读 → 返回空
    return entries
  }

  for (const file of files) {
    const filePath = join(dirPath, file)
    try {
      const sourceCode = await readFile(filePath, 'utf-8')
      const fileUrl = pathToFileURL(filePath).href
      const mod = (await import(fileUrl)) as Partial<WorkflowModule>

      if (!mod.meta || typeof mod.default !== 'function') {
        console.warn(`[workflow] skipping ${file}: missing meta or default export`)
        continue
      }

      // meta.name 缺省时取文件名（去 .js）
      const meta: WorkflowMeta = {
        ...mod.meta,
        name: mod.meta.name ?? basename(file, '.js'),
      }

      entries.push({
        meta,
        source,
        filePath,
        sourceCode,
        execute: mod.default,
      })
    } catch (e) {
      console.warn(`[workflow] failed to load ${file}: ${e instanceof Error ? e.message : e}`)
    }
  }

  return entries
}

/**
 * 扫描项目目录下的 `.c0de/workflows/*.js` 文件，source 标记为 'project'。
 */
async function discoverWorkflows(projectDir: string): Promise<WorkflowEntry[]> {
  return discoverFromDir(join(projectDir, PROJECT_WORKFLOWS_DIR), 'project')
}

/**
 * 扫描全局 `~/.c0de/workflows/*.js` 文件，source 标记为 'user'。
 * 目录不存在时返回空数组（与项目级一致）。
 */
async function discoverGlobalWorkflows(): Promise<WorkflowEntry[]> {
  return discoverFromDir(join(homedir(), GLOBAL_WORKFLOWS_DIR), 'user')
}

export { discoverGlobalWorkflows, discoverWorkflows }
