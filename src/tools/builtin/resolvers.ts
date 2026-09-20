// 内置 URL 解析器（spec §3.10）。
//
// registry 框架（createURLRegistry / registerURLResolver / resolveURL 分发）见
// ../resolver.ts。这里实现具体 scheme 的内容来源：
//   - file://  → 本地文件（相对 ctx.cwd 或 cwd 内绝对路径，safeResolve 沙箱约束）
//   - skill:// → 技能文件（name 单路径段），项目 .c0de/skills/<name>(.md|/SKILL.md)
//                优先于全局 ~/.c0de/skills/<name>(.md|/SKILL.md)
//
// agent:// pr:// issue:// 依赖未实现的子 agent 输出与 GitHub 访问，暂不内置。
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import type { URLRegistry, URLResolver } from '../../shared/types/tool.js'
import { safeResolve } from '../../shared/utils/path.js'
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

/**
 * file:// 解析器：`file://rel/path` 相对 cwd；`file:///abs/path` 用绝对路径。
 * 与 read/grep/glob/bash 同口径：解析结果必须落在 cwd 内（safeResolve 沙箱）——
 * read 工具 permission=auto，若放行任意绝对路径/../，模型可无确认读取
 * 工作目录外文件（如 ~/.ssh）。
 */
function createFileResolver(): URLResolver {
  return {
    scheme: 'file',
    resolve: async (url, ctx) => {
      const rest = stripScheme(url)
      // file:///abs → rest 形如 /abs（已含前导斜杠）；file://rel → rest 形如 rel。
      const path = safeResolve(ctx.cwd, rest)
      if (path === null) {
        throw new Error(`file:// path "${rest}" escapes the working directory`)
      }
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

/** skill:// 解析器：技能文件候选路径（项目优先于全局）。
 *  name 必须是单个路径段：此前未校验，'../config' 可读出 .c0de/config.md，
 *  绝对路径经 resolvePath 前缀重置可读出磁盘任意 .md 文件。 */
function createSkillResolver(opts?: { homeDir?: string }): URLResolver {
  const home = opts?.homeDir ?? homedir()
  return {
    scheme: 'skill',
    resolve: async (url, ctx) => {
      const name = stripScheme(url)
      if (!name) throw new Error('skill URL requires a name, e.g. skill://brainstorming')
      if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
        throw new Error(`Invalid skill name "${name}": must be a single path segment (no /, ..)`)
      }
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
