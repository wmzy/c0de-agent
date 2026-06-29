import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectInfo } from '../core/types.js'
import { resolveProject } from './resolve.js'

/** 框架推断映射：依赖名 → 框架名（按常见前端/后端框架）。 */
const FRAMEWORK_MAP: Record<string, string> = {
  react: 'react',
  'react-dom': 'react',
  vue: 'vue',
  svelte: 'svelte',
  '@angular/core': 'angular',
  next: 'next.js',
  nuxt: 'nuxt',
  '@nestjs/core': 'nest',
  '@hono/node-server': 'hono',
  hono: 'hono',
  express: 'express',
  fastify: 'fastify',
}

/** 语言推断映射：文件后缀 → 语言名。 */
const EXT_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.swift': 'Swift',
}

/** 安全读 package.json，失败返回 null。 */
function readPackageJson(cwd: string): Record<string, unknown> | null {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 从 package.json 的 deps 推断主框架。 */
function inferFramework(pkg: Record<string, unknown>): string | undefined {
  const deps = {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
  }
  if (!deps) return undefined
  for (const depName of Object.keys(deps)) {
    const mapped = FRAMEWORK_MAP[depName]
    if (mapped) return mapped
  }
  return undefined
}

/** 递归扫描源文件后缀统计，推断主语言（浅层，避免深扫 node_modules）。 */
function inferLanguage(cwd: string): string {
  const counts: Record<string, number> = {}
  const queue: string[] = [join(cwd, 'src')]
  let scanned = 0
  const MAX_SCAN = 500 // 防御性上限

  while (queue.length > 0 && scanned < MAX_SCAN) {
    const current = queue.shift() as string
    scanned++
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry)
      let st: { isDirectory(): boolean; isFile(): boolean }
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue
        queue.push(full)
      } else if (st.isFile()) {
        const dot = entry.lastIndexOf('.')
        if (dot < 0) continue
        const ext = entry.slice(dot).toLowerCase()
        const lang = EXT_LANGUAGE_MAP[ext]
        if (lang) counts[lang] = (counts[lang] ?? 0) + 1
      }
    }
  }

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return sorted[0]?.[0] ?? 'unknown'
}

/** 探测项目信息：name/language/framework/gitBranch，全部失败回退安全默认值。 */
function detectProjectInfo(cwd: string): ProjectInfo {
  const pkg = readPackageJson(cwd)
  const name = ((pkg && typeof pkg.name === 'string' && pkg.name) || 'project') as string
  const framework = pkg ? inferFramework(pkg) : undefined

  let language = 'unknown'
  if (existsSync(join(cwd, 'src'))) {
    language = inferLanguage(cwd)
  } else if (pkg) {
    language = 'JavaScript'
  }

  // 复用已有 git 探测（resolveProject），不重复造轮子
  const resolved = resolveProject(cwd)
  // resolveProject.gitBranch 为 string | null，ProjectInfo.gitBranch 为 string | undefined
  const gitBranch = resolved.vcs === 'git' ? (resolved.gitBranch ?? undefined) : undefined

  return {
    name,
    language,
    framework,
    rootDir: cwd,
    gitBranch,
  }
}

export { detectProjectInfo }
