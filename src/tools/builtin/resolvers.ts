// 内置 URL 解析器（spec §3.10）。
//
// registry 框架（createURLRegistry / registerURLResolver / resolveURL 分发）见
// ../resolver.ts。这里实现具体 scheme 的内容来源：
//   - file://  → 本地文件（相对 ctx.cwd 或绝对路径）
//   - skill:// → 技能文件，项目 .c0de/skills/<name>(.md|/SKILL.md) 优先于
//                全局 ~/.c0de/skills/<name>(.md|/SKILL.md)
//
// agent:// pr:// issue:// 依赖未实现的子 agent 输出与 GitHub 访问，暂不内置。
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import type { URLRegistry, URLResolver } from '../../shared/types/tool.js'
import { createURLRegistry, registerURLResolver } from '../resolver.js'

/** 从 `scheme://rest` 中取出 rest（scheme 已校验过，直接切首个 `://`）。 */
function stripScheme(url: string): string {
  const idx = url.indexOf('://')
  return idx < 0 ? url : url.slice(idx + 3)
}

/** 读文件，读不到抛错（由 resolveURL 包装成 error result）。 */
async function readOrFail(path: string): Promise<string> {
  return readFile(path, 'utf-8')
}

/** file:// 解析器：`file://rel/path` 相对 cwd；`file:///abs/path` 用绝对路径。 */
function createFileResolver(): URLResolver {
  return {
    scheme: 'file',
    resolve: async (url, ctx) => {
      const rest = stripScheme(url)
      // file:///abs → rest 形如 /abs（已含前导斜杠）；file://rel → rest 形如 rel。
      const path = resolvePath(ctx.cwd, rest)
      return readOrFail(path)
    },
  }
}

/** 按优先级返回第一个可读候选文件的路径，全部缺失时返回 null。 */
async function firstExistingFile(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    try {
      // 用 readFile 探测：能读到即返回。失败的候选静默跳过（ENOENT 等）。
      await readFile(c, 'utf-8')
      return c
    } catch {
      // 继续尝试下一个候选路径
    }
  }
  return null
}

/** skill:// 解析器：技能文件候选路径（项目优先于全局）。 */
function createSkillResolver(opts?: { homeDir?: string }): URLResolver {
  const home = opts?.homeDir ?? homedir()
  return {
    scheme: 'skill',
    resolve: async (url, ctx) => {
      const name = stripScheme(url)
      if (!name) throw new Error('skill URL requires a name, e.g. skill://brainstorming')
      const candidates = [
        resolvePath(ctx.cwd, '.c0de', 'skills', `${name}.md`),
        resolvePath(ctx.cwd, '.c0de', 'skills', name, 'SKILL.md'),
        resolvePath(home, '.c0de', 'skills', `${name}.md`),
        resolvePath(home, '.c0de', 'skills', name, 'SKILL.md'),
      ]
      const found = await firstExistingFile(candidates)
      if (!found) {
        throw new Error(
          `Skill "${name}" not found. Looked in:\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
        )
      }
      return readOrFail(found)
    },
  }
}

/** 内置 URL 解析器注册表：预装 file + skill。 */
function createDefaultURLRegistry(opts?: { homeDir?: string }): URLRegistry {
  const reg = createURLRegistry()
  registerURLResolver(reg, createFileResolver())
  registerURLResolver(reg, createSkillResolver(opts))
  return reg
}

export { createDefaultURLRegistry, createFileResolver, createSkillResolver }
