// 仓库上下文文件（repo context files）发现与加载——对标 oh-my-pi 的 context-files
// 体系：克隆一个配置过 Claude Code / Cursor / Copilot / Cline 等工具的仓库后，
// 其自带的 AGENTS.md / CLAUDE.md / .cursor/rules 等指导文件自动进入 system prompt，
// 无需手工搬运。纯文本指导（非可执行内容），恒注入（与 .c0de/prompts 的信任
// 门禁不同口径）；config.contextFiles.enabled 可整体关闭。
//
// 发现规则（对 omp 的裁剪适配）：
// - AGENTS.md / CLAUDE.md：从 cwd 逐级向上走到仓库根（最近的 .git 祖先），
//   每层取一个（AGENTS.md 优先；空文件不占槽——防空文件遮蔽另一格式的有效内容）。
// - cwd 层附加格式：.github/copilot-instructions.md、.cursorrules（legacy，恒注入）、
//   .cursor/rules/*.md(c) 与 .windsurf/rules/*.md（frontmatter 门控：alwaysApply /
//   globs，仅 globs 的只列目录不注入正文）、.clinerules（最近的，文件或目录 *.md）。
// - config.contextFiles.extra：额外文件名（拒绝路径分隔符），逐级向上发现，
//   additive 不占槽。用户级外来目录（~/.claude 等）不读——本仓已有自己的全局
//   覆写层（~/.c0de/prompts、~/.c0de/skills）。
// - 子目录更深处的 AGENTS.md 不注入正文（token 成本），只列指针提示「改该目录
//   前先 read」。
// - 所有正文做 @import 展开（.cursor 生态惯例），未闭合代码围栏补闭合，防止
//   污染 system prompt 后续段落。
//
// 每轮对话重新发现（与提示词覆写层同口径）：改动下一轮即生效，无需重启。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 注入 system prompt 的上下文文件。 */
export type LoadedContextFile = {
  /** 展示用来源路径（绝对路径）。 */
  path: string
  /** 正文（frontmatter 剥离 + @import 展开后）。 */
  content: string
  /** false = 子 agent 剔除（omp 口径：AGENTS.md/CLAUDE.md 只注入主 agent，
   *  子 agent 的 assignment 自带上下文，省 token）。 */
  forSubagents: boolean
}

/** 仅按需触发的 glob 规则（cursor/windsurf 的 globs 形态）：不注入正文，
 *  只在段尾列目录（名称 + globs + description），模型改到匹配文件时自行 read。 */
export type DomainRuleHint = { name: string; globs: string; description: string }

/** 更深处的 AGENTS.md 指针（不注入正文）。 */
export type DeepAgentsMd = { path: string; dir: string }

/** 一次发现的完整结果。 */
export type ContextFileBundle = {
  files: LoadedContextFile[]
  domainRules: DomainRuleHint[]
  deepAgentsMd: DeepAgentsMd[]
}

export const EMPTY_CONTEXT_FILES: ContextFileBundle = {
  files: [],
  domainRules: [],
  deepAgentsMd: [],
}

// 发现结果短 TTL 缓存：文件读取本身廉价，但深目录 AGENTS.md 扫描（≤3 层
// readdir）在 monorepo 上每轮重跑不划算；5s 让「同一 run 的连续多轮」命中
// 缓存，跨轮（用户间隔）仍会重新发现——改动下一轮生效的语义保留。
const CACHE_TTL_MS = 5_000
const discoveryCache = new Map<string, { expiresAt: number; bundle: ContextFileBundle }>()

/** 清空发现缓存（测试用）。 */
export function clearContextFilesCache(): void {
  discoveryCache.clear()
}

// ── 工具函数 ───────────────────────────────────────────────

/** 最近的仓库根（含 .git 的最近祖先）；无 .git 时返回 null。 */
function findRepoRoot(from: string): string | null {
  let cur = resolve(from)
  for (;;) {
    if (existsSync(join(cur, '.git'))) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/** 读文件为字符串；不存在/不可读/目录返回 null（best-effort 层）。 */
function readTextFile(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null
    const text = readFileSync(path, 'utf8')
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

/** 从 start 逐级向上到 boundary（含），收集每层的候选文件。 */
function walkUp(start: string, boundary: string): string[] {
  const dirs: string[] = []
  let cur = resolve(start)
  const stop = resolve(boundary)
  for (;;) {
    dirs.push(cur)
    if (cur === stop) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return dirs
}

// ── frontmatter 解析（cursor/windsurf 规则门控） ─────────────

/** 从 md 文本剥离 YAML frontmatter，返回 { body, fm }。无 frontmatter 时 fm 为空对象。 */
function splitFrontmatter(md: string): { body: string; fm: Record<string, string> } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(md)
  if (!m) return { body: md, fm: {} }
  const fm: Record<string, string> = {}
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (kv) fm[kv[1] ?? ''] = (kv[2] ?? '').trim()
  }
  return { body: md.slice(m[0].length), fm }
}

/** frontmatter 的 always 判定（cursor 的 alwaysApply / windsurf 的 trigger_always / 通用 always）。 */
function fmAlways(fm: Record<string, string>): boolean {
  const v = fm.alwaysApply ?? fm.always ?? fm.trigger_always
  return v === 'true' || v === 'True'
}

/** frontmatter 的 globs 取值（string | YAML 内联数组形态 "['a','b']" 都兼容）。 */
function fmGlobs(fm: Record<string, string>): string | undefined {
  const v = fm.globs ?? fm.trigger_glob
  if (!v) return undefined
  // "['**/*.ts','**/*.tsx']" → "**/*.ts, **/*.tsx"
  const inner = /^\[.*\]$/.test(v) ? v.slice(1, -1) : v
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
    .join(', ')
}

// ── @import 展开（omp at-imports.ts 的移植） ────────────────

const AT_IMPORT_RE = /(^|[ \t])@([./~A-Za-z0-9_-](?:\\ |[^\s])*)/g
const MAX_AT_IMPORT_EXPANSIONS = 256

/** 行是否为代码围栏开/闭（``` 或 ~~~，长度 ≥3）。 */
function isFenceLine(line: string): boolean {
  return /^( {0,3})(`{3,}|~{3,})/.test(line)
}

/**
 * 展开 md 中的 @file 引用：`@./rules/xx.md`、`@~/notes.md`、`@AGENTS.md`。
 * 围栏代码块与行内代码（反引号奇偶性）内不展开；递归深度与总次数封顶；
 * 环（当前 import 链内重复）跳过；读不到的引用保留原 token。
 */
export function expandAtImports(text: string, fromFile: string): string {
  let budget = MAX_AT_IMPORT_EXPANSIONS
  const expand = (content: string, file: string, chain: string[]): string => {
    if (budget <= 0) return content
    // 逐行处理：跟踪围栏状态；行内再按反引号奇偶性分段跳过代码 span。
    const lines = content.split('\n')
    let inFence = false
    const out: string[] = []
    for (const line of lines) {
      if (isFenceLine(line)) {
        inFence = !inFence
        out.push(line)
        continue
      }
      if (inFence) {
        out.push(line)
        continue
      }
      let result = ''
      let rest = line
      for (;;) {
        const tick = rest.indexOf('`')
        if (tick === -1) {
          result += expandSegment(rest, file, chain)
          break
        }
        // 反引号前的 prose 段展开；成对代码 span 原样保留
        result += expandSegment(rest.slice(0, tick), file, chain)
        const close = rest.indexOf('`', tick + 1)
        if (close === -1) {
          result += rest.slice(tick)
          break
        }
        result += rest.slice(tick, close + 1)
        rest = rest.slice(close + 1)
      }
      out.push(result)
    }
    return out.join('\n')
  }

  const expandSegment = (segment: string, file: string, chain: string[]): string => {
    if (!segment.includes('@')) return segment
    AT_IMPORT_RE.lastIndex = 0
    return segment.replace(AT_IMPORT_RE, (whole, lead: string, ref: string) => {
      if (budget <= 0) return whole
      const target = ref.replace(/[.,;:!?)\]}"']+$/, '')
      if (!target || !/[./~]/.test(target)) return whole // 纯单词（@user 提及类）不展开
      let abs: string
      if (target.startsWith('~/')) abs = join(homedir(), target.slice(2))
      else if (target.startsWith('/')) abs = target
      else abs = resolve(dirname(file), target.replace(/\\ /g, ' '))
      if (chain.includes(abs)) return whole // 环
      const imported = readTextFile(abs)
      if (imported === null) return whole
      budget -= 1
      return lead + expand(imported, abs, [...chain, abs])
    })
  }

  return expand(text, resolve(fromFile), [resolve(fromFile)])
}

/** 未闭合的 ``` 围栏补一个闭合行，防止正文污染 system prompt 后续段落。 */
export function closeOpenFence(content: string): string {
  let fences = 0
  for (const line of content.split('\n')) {
    if (isFenceLine(line)) fences += 1
  }
  return fences % 2 === 1 ? `${content}\n\`\`\`` : content
}

// ── 发现主流程 ─────────────────────────────────────────────

const HIDDEN_SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  'target',
])
const DEEP_AGENTS_MD_LIMIT = 200

/** extra 文件名校验：纯文件名（拒绝路径分隔符与内置保留名）。 */
function validateExtraName(name: string): boolean {
  if (!name || name.includes('/') || name.includes('\\')) return false
  return !['agents.md', 'claude.md'].includes(name.toLowerCase())
}

/** 扫描 cwd 之下（深度 ≤3）更深处的 AGENTS.md 指针。 */
function scanDeepAgentsMd(cwd: string, loaded: Set<string>): DeepAgentsMd[] {
  const out: DeepAgentsMd[] = []
  const walk = (dir: string, depth: number): void => {
    if (out.length >= DEEP_AGENTS_MD_LIMIT || depth > 3) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || HIDDEN_SKIP.has(entry)) continue
      const path = join(dir, entry)
      let isDir: boolean
      try {
        isDir = statSync(path).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        walk(path, depth + 1)
      } else if (entry === 'AGENTS.md' && !loaded.has(path)) {
        out.push({ path, dir })
        loaded.add(path)
        if (out.length >= DEEP_AGENTS_MD_LIMIT) return
      }
    }
  }
  walk(cwd, 0)
  return out
}

/**
 * 发现当前 cwd 可见的仓库上下文文件。best-effort：单文件读取失败跳过，
 * 永不抛错（prompt 组装不被上下文文件层阻断）。
 *
 * @param cwd 会话工作目录
 * @param opts.enabled config.contextFiles.enabled（false 返回空 bundle）
 * @param opts.extra config.contextFiles.extra（额外向上走的文件名）
 */
export function discoverContextFiles(
  cwd: string,
  opts: { enabled?: boolean; extra?: string[] } = {},
): ContextFileBundle {
  if (opts.enabled === false) return EMPTY_CONTEXT_FILES
  const key = `${resolve(cwd)}|${JSON.stringify(opts)}`
  const cached = discoveryCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.bundle
  const bundle = discoverContextFilesUncached(cwd, opts)
  discoveryCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, bundle })
  return bundle
}

function discoverContextFilesUncached(
  cwd: string,
  opts: { enabled?: boolean; extra?: string[] } = {},
): ContextFileBundle {
  const root = resolve(cwd)
  const repoRoot = findRepoRoot(root)
  const boundary = repoRoot ?? root
  const dirs = walkUp(root, boundary)

  const files: LoadedContextFile[] = []
  const domainRules: DomainRuleHint[] = []
  const loadedPaths = new Set<string>()

  const push = (path: string, content: string, forSubagents: boolean): void => {
    const abs = resolve(path)
    if (loadedPaths.has(abs)) return
    loadedPaths.add(abs)
    files.push({
      path: abs,
      content: closeOpenFence(expandAtImports(content, abs)),
      forSubagents,
    })
  }

  // 1) AGENTS.md / CLAUDE.md 层级注入：近 cwd 层在前（更显著），每层一个槽。
  for (const dir of dirs) {
    const agents = readTextFile(join(dir, 'AGENTS.md'))
    const picked = agents ?? readTextFile(join(dir, 'CLAUDE.md'))
    if (picked !== null) push(join(dir, agents !== null ? 'AGENTS.md' : 'CLAUDE.md'), picked, false)
  }

  // 2) extra 文件名：逐级向上，additive（不占槽、全部收集）。
  for (const name of (opts.extra ?? []).filter(validateExtraName)) {
    for (const dir of dirs) {
      const text = readTextFile(join(dir, name))
      if (text !== null) push(join(dir, name), text, true)
    }
  }

  // 3) cwd 层附加格式。
  const copilot = readTextFile(join(root, '.github', 'copilot-instructions.md'))
  if (copilot !== null) push(join(root, '.github', 'copilot-instructions.md'), copilot, true)

  const cursorLegacy = readTextFile(join(root, '.cursorrules'))
  if (cursorLegacy !== null) push(join(root, '.cursorrules'), cursorLegacy, true)

  for (const rulesDir of [join(root, '.cursor', 'rules'), join(root, '.windsurf', 'rules')]) {
    let entries: string[]
    try {
      entries = readdirSync(rulesDir)
    } catch {
      continue
    }
    for (const entry of entries.sort()) {
      if (!/\.(md|mdc)$/.test(entry)) continue
      const path = join(rulesDir, entry)
      const text = readTextFile(path)
      if (text === null) continue
      const { body, fm } = splitFrontmatter(text)
      const name = entry.replace(/\.(md|mdc)$/, '')
      const globs = fmGlobs(fm)
      if (fmAlways(fm)) {
        push(path, body, true)
      } else if (globs) {
        domainRules.push({ name, globs, description: fm.description ?? '' })
      }
      // 两者皆无：cursor 语义为未激活——跳过（不注入也不列目录）。
    }
  }

  // 4) .clinerules：向上找最近一个（文件或目录 *.md，目录内每文件恒注入）。
  for (const dir of dirs) {
    const p = join(dir, '.clinerules')
    if (!existsSync(p)) continue
    try {
      if (statSync(p).isDirectory()) {
        for (const entry of readdirSync(p).sort()) {
          if (!/\.md$/.test(entry)) continue
          const text = readTextFile(join(p, entry))
          if (text !== null) push(join(p, entry), text, true)
        }
      } else {
        const text = readTextFile(p)
        if (text !== null) push(p, text, true)
      }
    } catch {
      // 单条目损坏跳过
    }
    break // 只取最近一个
  }

  // 5) 更深处 AGENTS.md 指针（主 agent 专属提示，见 render）。
  const deepAgentsMd = scanDeepAgentsMd(root, loadedPaths)

  return { files, domainRules, deepAgentsMd }
}

/** 渲染为 system prompt 段落正文（prompt-registry 的 'repo-rules' section 消费）。 */
export function renderContextFilesSection(bundle: ContextFileBundle): string {
  const { files, domainRules, deepAgentsMd } = bundle
  if (files.length === 0 && domainRules.length === 0 && deepAgentsMd.length === 0) return ''
  const lines: string[] = ['<repo-rules>']
  if (files.length > 0) {
    lines.push(
      "The user's repository ships these context files. You MUST follow them for all tasks in this repo:",
    )
    for (const f of files) {
      lines.push(`<file path="${f.path}">`)
      lines.push(f.content.trim())
      lines.push('</file>')
    }
  }
  if (domainRules.length > 0) {
    lines.push(
      'Glob-scoped rule files exist (read them with the read tool before editing files they match):',
    )
    for (const r of domainRules) {
      lines.push(`- ${r.name} (${r.globs})${r.description ? `: ${r.description}` : ''}`)
    }
  }
  if (deepAgentsMd.length > 0) {
    lines.push(
      'Deeper AGENTS.md files exist (deeper rules override higher ones — read them before changing files under their directories):',
    )
    for (const d of deepAgentsMd) lines.push(`- ${d.path}`)
  }
  lines.push('</repo-rules>')
  return lines.join('\n')
}
