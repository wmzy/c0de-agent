import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AgentDefinition, AgentMode, AgentSource } from './types.js'

/** 默认 agent markdown 目录（相对项目根）。 */
const AGENTS_DIR = '.c0de/agents'

/** 解析简单 YAML 行（key: value 或 key: [a, b]）。不处理嵌套。 */
function parseFrontmatterLine(line: string): [string, unknown] | null {
  const idx = line.indexOf(':')
  if (idx === -1) return null
  const key = line.slice(0, idx).trim()
  let value: unknown = line.slice(idx + 1).trim()
  // 数组：[a, b, c]
  if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
    value = value
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  } else if (value === 'true') {
    value = true
  } else if (value === 'false') {
    value = false
  } else {
    // 尝试数字
    const num = Number(value)
    if (!Number.isNaN(num) && value !== '') value = num
  }
  return [key, value]
}

/** 解析单个 markdown 文件为 AgentDefinition。无 frontmatter 返回 null。 */
async function loadAgentFile(
  filePath: string,
  source: AgentSource,
): Promise<AgentDefinition | null> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return null
  }

  // frontmatter 必须以 --- 开头
  if (!content.startsWith('---')) return null
  const endIdx = content.indexOf('\n---', 3)
  if (endIdx === -1) return null

  const fmRaw = content.slice(3, endIdx)
  const body = content.slice(endIdx + 4).trim() // 跳过 \n---

  const fm: Record<string, unknown> = {}
  for (const line of fmRaw.split('\n')) {
    const parsed = parseFrontmatterLine(line)
    if (parsed) fm[parsed[0]] = parsed[1]
  }

  const name = (fm.name as string) ?? basename(filePath, '.md')
  const description = (fm.description as string) ?? ''

  const mode = (fm.mode as AgentMode) ?? 'subagent'

  return {
    name,
    description,
    systemPrompt: body,
    ...(fm.tools ? { tools: fm.tools as string[] } : {}),
    ...(fm.model ? { model: fm.model as string } : {}),
    mode,
    ...(fm.isolated !== undefined ? { isolated: fm.isolated as boolean } : {}),
    ...(fm.maxRecursion !== undefined ? { maxRecursion: fm.maxRecursion as number } : {}),
    source,
    filePath,
  }
}

/** 加载项目 agents 目录下所有 .md 为 AgentDefinition（源: project）。 */
async function loadAgents(projectDir: string): Promise<AgentDefinition[]> {
  const agentsDir = join(projectDir, AGENTS_DIR)
  let entries: string[]
  try {
    const s = await stat(agentsDir)
    if (!s.isDirectory()) return []
    entries = await readdir(agentsDir)
  } catch {
    return []
  }

  const defs: AgentDefinition[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const def = await loadAgentFile(join(agentsDir, entry), 'project')
    if (def) defs.push(def)
  }
  return defs
}

export { loadAgentFile, loadAgents }
