// 技能发现（system-prompt-overhaul plan 遗留的 skills 段数据源 + 主设计 §25
// 「技能发现」的最小落地）：扫描项目 `.c0de/skills/` 与全局 `<config>/skills/`
// 下每个含 SKILL.md 的目录，取 frontmatter `name`（缺省用目录名）作为技能名，
// 由宿主注入 LoopDeps.skills → PromptContext.skills → system prompt 的
// ## Loaded Skills 段。进程生命周期内按 cwd 缓存（技能是 system prompt 材料，
// 运行中热加载无意义）。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveGlobalConfigDir } from './config.js'

const SKILL_FILE = 'SKILL.md'

/** 从 SKILL.md 的 YAML frontmatter 取 name；无 frontmatter/无 name 用目录名。 */
function parseSkillName(md: string, fallback: string): string {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(md)
  if (fm) {
    const name = /^name:\s*(.+)$/m.exec(fm[1] ?? '')
    if (name?.[1]) return name[1].trim()
  }
  return fallback
}

/** 扫描一个技能目录：`<dir>/<name>/SKILL.md`。单个条目读取失败跳过。 */
function scanDir(dir: string): string[] {
  if (!existsSync(dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    try {
      const path = join(dir, entry)
      if (!statSync(path).isDirectory()) continue
      const skillMd = join(path, SKILL_FILE)
      if (!existsSync(skillMd)) continue
      out.push(parseSkillName(readFileSync(skillMd, 'utf8'), entry))
    } catch {
      // 单个技能损坏不阻断其余
    }
  }
  return out.sort()
}

const cache = new Map<string, string[]>()

/** 发现当前项目可见的技能名（项目级 + 全局级，去重）。 */
export function discoverSkills(cwd: string): string[] {
  const cached = cache.get(cwd)
  if (cached) return cached
  const names = Array.from(
    new Set([
      ...scanDir(join(cwd, '.c0de', 'skills')),
      ...scanDir(join(resolveGlobalConfigDir(), 'skills')),
    ]),
  )
  cache.set(cwd, names)
  return names
}
