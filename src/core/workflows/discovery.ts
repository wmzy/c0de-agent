import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WorkflowEntry, WorkflowMeta, WorkflowModule } from './types.js'

/** 工作流目录相对路径。 */
const WORKFLOWS_DIR = '.c0de/workflows'

/**
 * 扫描项目目录下的 `.c0de/workflows/*.js` 文件，dynamic import 后转为 WorkflowEntry。
 * import 失败的文件跳过（warn），不阻塞其他工作流加载。
 */
async function discoverWorkflows(projectDir: string): Promise<WorkflowEntry[]> {
  const dirPath = join(projectDir, WORKFLOWS_DIR)
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
        source: 'project',
        filePath,
        sourceCode,
        execute: mod.default,
      })
    } catch (e) {
      console.warn(
        `[workflow] failed to load ${file}: ${e instanceof Error ? e.message : e}`,
      )
    }
  }

  return entries
}

export { discoverWorkflows }