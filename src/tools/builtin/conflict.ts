// conflict:// 冲突解决机制（移植自 oh-my-pi 的 conflict-detect / conflict-uri）。
//
// read 工具读到含未解决 git merge 冲突标记的文件时，用严格形态状态机扫描
// `<<<<<<< / ||||||| / ======= / >>>>>>>` 块，按会话注册为稳定递增的
// conflict://<id>；写通道按记录的区块内容定位并 splice 出解决结果。
//
// 保留的 omp 核心算法与守卫：
//   - 严格列 0 标记形态（前缀后要么行尾要么恰好一个空格+标签；缩进/贴字/
//     多余字符一律不认——代码里长得像标记的行不能误报成冲突）
//   - 只收闭块：opener+separator+closer 全在窗口内才收录；窗口尾未闭合的
//     opener 丢弃（模型看得见开标记，会自己扩窗重读）
//   - id 只在「同文件同位置同内容」时复用；内容变了绝不继承旧 id
//   - reconcile：读/写前复检磁盘——块被改动/消失则退役 id；纯行漂移（上方
//     插入删除行）按最近内容匹配跟随
//   - splice 按记录内容定位（记录行号优先，其次取最近内容匹配）：块被
//     out-of-band 编辑破坏时拒绝写入并报错，而不是把文件写坏
//   - 批量 conflict://* 的 per-id 指令块校验：只接受 `<id>: @side` 行；混入
//     非指令行或 `<id>: <字面量>` 形态直接报错，绝不静默降级为「把指令文本
//     统一贴进每个块还报告成功」（omp 实证过该静默降级事故）
// 不移植（c0de 无对应物）：TUI hashline 展示、LSP writethrough、edit 快照、
// 边界回声修剪（boundary-echo repair）。
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { errorMessage } from '../../shared/utils/string.js'

const OURS_PREFIX = '<<<<<<<'
const BASE_PREFIX = '|||||||'
const SEPARATOR = '======='
const THEIRS_PREFIX = '>>>>>>>'

/** 记录的冲突区块（行号 1-indexed；section 行已去尾部 \r 做 LF 规范化）。 */
interface ConflictBlock {
  /** `<<<<<<<` 所在行。 */
  startLine: number
  /** `=======` 所在行。 */
  separatorLine: number
  /** `>>>>>>>` 所在行。 */
  endLine: number
  /** `|||||||` 所在行（仅 diff3 三方合并）。 */
  baseLine?: number
  oursLabel?: string
  baseLabel?: string
  theirsLabel?: string
  oursLines: string[]
  baseLines?: string[]
  theirsLines: string[]
}

/** 注册表条目 = 区块 + 会话内稳定 id + 绝对路径。 */
interface ConflictEntry extends ConflictBlock {
  id: number
  absolutePath: string
}

/** 冲突的可选侧视图。 */
type ConflictScope = 'ours' | 'theirs' | 'base'

/** 解析后的 `conflict://<N>` / `conflict://<N>/<scope>` / `conflict://*`。 */
interface ParsedConflictUri {
  /** `"*"` 仅用于批量写。 */
  id: number | '*'
  scope?: ConflictScope
}

function stripTrailingCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * 列 0 严格标记匹配：行等于前缀本身，或前缀 + 恰好一个空格 + 标签。
 * 返回标签（无标签为 ''），不匹配返回 null。缩进（` <<<<<<<`）、贴字
 * （`<<<<<<<HEAD`）一律不认——与 git 产出冲突标记的口径一致，防止代码里
 * 长得像的行误报。
 */
function matchMarker(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix)) return null
  if (line.length === prefix.length) return ''
  if (line.charCodeAt(prefix.length) !== 32 /* space */) return null
  return line.slice(prefix.length + 1)
}

/**
 * 扫描已收集的文件行数组中的完整冲突块。`firstLine` 是 lines[0] 的
 * 1-indexed 行号（窗口化读取传窗口首行）。
 *
 * 状态机按 idle → ours → [base] → theirs 推进；同一形态错乱（base 出现在
 * theirs 后、separator 出现在 idle 等）整体重置。窗口尾未闭合的块丢弃。
 * 行尾 \r 先剥掉再做匹配（CRLF checkout 与 LF 同口径），section 内容按
 * LF 规范化存储（splice 写回时按磁盘现状补 \r）。
 */
function scanConflictMarkers(lines: readonly string[], firstLine: number): ConflictBlock[] {
  const blocks: ConflictBlock[] = []
  let phase: 'idle' | 'ours' | 'base' | 'theirs' = 'idle'
  let partial: {
    startLine: number
    oursLabel?: string
    oursLines: string[]
    baseLine?: number
    baseLabel?: string
    baseLines?: string[]
    separatorLine?: number
    theirsLines?: string[]
  } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = stripTrailingCr(lines[i] ?? '')
    const ln = firstLine + i

    // ours 开标记总是重开一个新块：嵌套的 `<<<<<<< second` 会把外层未闭块
    // 作废，从内层重新开始（git 不会产出嵌套，这是对伪嵌套的容错）。
    const oursLabel = matchMarker(line, OURS_PREFIX)
    if (oursLabel !== null) {
      partial = { startLine: ln, oursLabel: oursLabel || undefined, oursLines: [] }
      phase = 'ours'
      continue
    }

    if (phase === 'idle' || partial === null) continue

    const baseLabel = matchMarker(line, BASE_PREFIX)
    if (baseLabel !== null) {
      if (phase !== 'ours') {
        // base 只能紧跟 ours 段；出现在其他位置说明形态错乱，重置
        partial = null
        phase = 'idle'
        continue
      }
      partial.baseLine = ln
      partial.baseLabel = baseLabel || undefined
      partial.baseLines = []
      phase = 'base'
      continue
    }

    // separator 必须是裸 `=======`（diff3/git 口径：分隔行不带标签）
    if (line === SEPARATOR) {
      if (phase === 'ours' || phase === 'base') {
        partial.separatorLine = ln
        partial.theirsLines = []
        phase = 'theirs'
      } else {
        partial = null
        phase = 'idle'
      }
      continue
    }

    const theirsLabel = matchMarker(line, THEIRS_PREFIX)
    if (theirsLabel !== null) {
      if (phase === 'theirs' && partial.separatorLine !== undefined && partial.theirsLines) {
        blocks.push({
          startLine: partial.startLine,
          separatorLine: partial.separatorLine,
          endLine: ln,
          baseLine: partial.baseLine,
          oursLabel: partial.oursLabel,
          baseLabel: partial.baseLabel,
          theirsLabel: theirsLabel || undefined,
          oursLines: partial.oursLines,
          baseLines: partial.baseLines,
          theirsLines: partial.theirsLines,
        })
      }
      // 闭标记形态不对（如没经过 separator）也重置，不留半截状态
      partial = null
      phase = 'idle'
      continue
    }

    if (phase === 'ours') partial.oursLines.push(line)
    else if (phase === 'base' && partial.baseLines) partial.baseLines.push(line)
    else if (phase === 'theirs' && partial.theirsLines) partial.theirsLines.push(line)
  }

  return blocks
}

/** 按记录重建标记块应有的文件行（LF 规范化形态）。 */
function buildRecordedRegion(entry: ConflictBlock): string[] {
  const out: string[] = []
  out.push(entry.oursLabel ? `${OURS_PREFIX} ${entry.oursLabel}` : OURS_PREFIX)
  out.push(...entry.oursLines)
  if (entry.baseLines !== undefined) {
    out.push(entry.baseLabel ? `${BASE_PREFIX} ${entry.baseLabel}` : BASE_PREFIX)
    out.push(...entry.baseLines)
  }
  out.push(SEPARATOR)
  out.push(...entry.theirsLines)
  out.push(entry.theirsLabel ? `${THEIRS_PREFIX} ${entry.theirsLabel}` : THEIRS_PREFIX)
  return out
}

/** 两个区块是否记录了相同的标记块内容（标签与三段 body），与坐标无关。 */
function conflictRegionsEqual(a: ConflictBlock, b: ConflictBlock): boolean {
  const ra = buildRecordedRegion(a)
  const rb = buildRecordedRegion(b)
  return ra.length === rb.length && ra.every((line, i) => line === rb[i])
}

/**
 * 在 lines 中定位 expected 的连续匹配。先试记录位置（快路径），否则取离
 * preferredIdx 最近的匹配——同内容块出现多次（真实冲突中几乎不可能）时按
 * 距离消歧。找不到返回 null（块被改动/删除——调用方据此拒绝写入）。
 */
function locateRegion(
  lines: readonly string[],
  expected: readonly string[],
  preferredIdx: number,
): { startIdx: number; endIdx: number } | null {
  if (expected.length === 0 || expected.length > lines.length) return null
  if (preferredIdx >= 0 && matchesAt(lines, preferredIdx, expected)) {
    return { startIdx: preferredIdx, endIdx: preferredIdx + expected.length - 1 }
  }
  let best: number | null = null
  let bestDist = Number.POSITIVE_INFINITY
  const limit = lines.length - expected.length
  for (let i = 0; i <= limit; i++) {
    if (!matchesAt(lines, i, expected)) continue
    const dist = Math.abs(i - preferredIdx)
    if (dist < bestDist) {
      best = i
      bestDist = dist
    }
  }
  if (best === null) return null
  return { startIdx: best, endIdx: best + expected.length - 1 }
}

function matchesAt(
  lines: readonly string[],
  startIdx: number,
  expected: readonly string[],
): boolean {
  if (startIdx < 0 || startIdx + expected.length > lines.length) return false
  for (let i = 0; i < expected.length; i++) {
    // 记录行已 LF 规范化；磁盘行可能带 \r，比较时容忍
    if (stripTrailingCr(lines[startIdx + i] ?? '') !== expected[i]) return false
  }
  return true
}

// ===== 会话冲突注册表 =====

/** 单会话注册条目上限：防长会话反复读写冲突文件导致注册表无界增长。 */
const MAX_BLOCKS_PER_SESSION = 200
/** 会话数上限（LRU 淘汰）：server 进程长驻，跨会话的 Map 本身也要有界。 */
const MAX_SESSIONS = 32

/** 按会话记录 read 浮出的冲突区块，分配稳定递增 id。 */
class ConflictRegistry {
  private nextId = 1
  private entriesById = new Map<number, ConflictEntry>()

  /**
   * 注册一批扫描结果，返回带 id 的条目（与入参顺序一致）。
   *
   * id 复用规则：同文件同位置且内容一致 → 复用旧 id 并刷新记录（重读刷新）；
   * 同位置但内容漂移 → 旧 id 作废、分配新 id（内容变了的块不能继承旧 id，
   * 否则模型会按旧记忆解决新内容）。同内容不同位置的块是各自独立的 id。
   */
  register(absolutePath: string, blocks: readonly ConflictBlock[]): ConflictEntry[] {
    const out: ConflictEntry[] = []
    for (const block of blocks) {
      out.push(this.registerOne(absolutePath, block))
    }
    // 超限按创建序淘汰最老 id。200+ 冲突已是病态场景；被淘汰只是丢失便捷
    // id，重读文件即可重建，不影响正确性。
    while (this.entriesById.size > MAX_BLOCKS_PER_SESSION) {
      const oldest = this.entriesById.keys().next().value
      if (oldest === undefined) break
      this.entriesById.delete(oldest)
    }
    return out
  }

  private registerOne(absolutePath: string, block: ConflictBlock): ConflictEntry {
    for (const existing of this.entriesById.values()) {
      if (existing.absolutePath !== absolutePath || existing.startLine !== block.startLine) continue
      if (conflictRegionsEqual(existing, block)) {
        const merged: ConflictEntry = { ...block, id: existing.id, absolutePath }
        this.entriesById.set(existing.id, merged)
        return merged
      }
      this.entriesById.delete(existing.id)
    }
    const id = this.nextId++
    const entry: ConflictEntry = { ...block, id, absolutePath }
    this.entriesById.set(id, entry)
    return entry
  }

  /**
   * 复检磁盘：读文件重扫后重定位已注册条目。文件不可读（被删/权限）时该
   * 路径全部 id 退役——重读文件即可重建，静默保留只会让后续写拿到陈旧锚点。
   */
  async reconcile(absolutePath: string): Promise<void> {
    let text: string
    try {
      text = await readFile(absolutePath, 'utf-8')
    } catch {
      this.invalidatePath(absolutePath)
      return
    }
    this.reconcileScanned(absolutePath, scanConflictMarkers(text.split('\n'), 1))
  }

  /**
   * 纯匹配重定位（不发 IO）：第一轮按「同位置同内容」配对（先于漂移匹配，
   * 保证同内容多块各守各的 id）；第二轮给未配对条目找最近的内容一致块跟随
   * 行漂移；仍未配对（被改动/消失）的 id 退役。
   */
  reconcileScanned(absolutePath: string, blocks: readonly ConflictBlock[]): void {
    const entries = this.entries().filter((entry) => entry.absolutePath === absolutePath)
    const available = new Set(blocks)
    const matched = new Map<ConflictEntry, ConflictBlock>()
    for (const entry of entries) {
      for (const block of available) {
        if (block.startLine === entry.startLine && conflictRegionsEqual(entry, block)) {
          matched.set(entry, block)
          available.delete(block)
          break
        }
      }
    }
    for (const entry of entries) {
      if (matched.has(entry)) continue
      let nearest: ConflictBlock | undefined
      let distance = Number.POSITIVE_INFINITY
      for (const block of available) {
        const delta = Math.abs(block.startLine - entry.startLine)
        if (delta < distance && conflictRegionsEqual(entry, block)) {
          nearest = block
          distance = delta
        }
      }
      if (nearest) {
        matched.set(entry, nearest)
        available.delete(nearest)
      }
    }
    for (const entry of entries) {
      const block = matched.get(entry)
      if (block) this.entriesById.set(entry.id, { ...entry, ...block, id: entry.id, absolutePath })
      else this.entriesById.delete(entry.id)
    }
  }

  get(id: number): ConflictEntry | undefined {
    return this.entriesById.get(id)
  }

  /** 全部条目快照（id 升序——Map 按插入序，id 单调递增）。 */
  entries(): ConflictEntry[] {
    return [...this.entriesById.values()]
  }

  /** 解决成功后退役单个 id。 */
  invalidate(id: number): void {
    this.entriesById.delete(id)
  }

  /** 退役某文件的全部 id。 */
  invalidatePath(absolutePath: string): void {
    for (const [id, entry] of this.entriesById) {
      if (entry.absolutePath === absolutePath) this.entriesById.delete(id)
    }
  }
}

const sessionRegistries = new Map<string, ConflictRegistry>()

/** 取会话的冲突注册表（首次使用时创建）。访问即刷新 LRU 序，超限淘汰最久
 *  未用会话——server 长驻进程中冲突注册表不能随会话数无界增长。 */
function getConflictRegistry(sessionId: string): ConflictRegistry {
  const existing = sessionRegistries.get(sessionId)
  if (existing) {
    sessionRegistries.delete(sessionId)
    sessionRegistries.set(sessionId, existing)
    return existing
  }
  const registry = new ConflictRegistry()
  sessionRegistries.set(sessionId, registry)
  while (sessionRegistries.size > MAX_SESSIONS) {
    const oldest = sessionRegistries.keys().next().value
    if (oldest === undefined) break
    sessionRegistries.delete(oldest)
  }
  return registry
}

/** read 命中冲突后的注册入口（无块时零开销直接返回）。 */
function registerConflicts(
  sessionId: string,
  absolutePath: string,
  blocks: readonly ConflictBlock[],
): ConflictEntry[] {
  if (blocks.length === 0) return []
  return getConflictRegistry(sessionId).register(absolutePath, blocks)
}

/**
 * 读/写前取条目：先复检该条目所在文件的磁盘现状（漂移跟随、失效退役），
 * 再取注册表；拿不到时抛出带「当前已注册清单」的可操作错误。
 */
async function requireConflictEntry(sessionId: string, id: number): Promise<ConflictEntry> {
  const registry = getConflictRegistry(sessionId)
  const registered = registry.get(id)
  if (registered) await registry.reconcile(registered.absolutePath)
  const entry = registry.get(id)
  if (!entry) throw conflictNotFoundError(registry, id)
  return entry
}

function conflictNotFoundError(registry: ConflictRegistry, id: number): Error {
  const byPath = new Map<string, number[]>()
  for (const entry of registry.entries()) {
    const ids = byPath.get(entry.absolutePath) ?? []
    ids.push(entry.id)
    byPath.set(entry.absolutePath, ids)
  }
  const known =
    byPath.size > 0
      ? `Registered: ${[...byPath].map(([p, ids]) => `${ids.map((n) => `#${n}`).join(', ')} in ${p}`).join('; ')}.`
      : 'No conflicts are registered.'
  return new Error(
    `Conflict #${id} not found: it was resolved, became stale, or no read has surfaced its block yet. ` +
      `Re-read the conflicted file to re-register its blocks. ${known}`,
  )
}

// ===== URI 解析 =====

const CONFLICT_SCOPES = new Set<string>(['ours', 'theirs', 'base'])
const CONFLICT_URI_RE = /^conflict:\/\/(.+)$/

/**
 * 解析 `conflict://<N>`、`conflict://<N>/<scope>`、`conflict://*`。
 * 非 conflict URL 返回 null；scheme 正确但 id/scope 非法时抛错——给模型
 * 明确的自纠信息，而不是稍后一个含糊的 not found。
 */
function parseConflictUri(raw: string): ParsedConflictUri | null {
  const match = raw.match(CONFLICT_URI_RE)
  if (!match) return null
  const tail = match[1] ?? ''
  const slashIdx = tail.indexOf('/')
  const idPart = slashIdx === -1 ? tail : tail.slice(0, slashIdx)
  const scopePart = slashIdx === -1 ? undefined : tail.slice(slashIdx + 1)

  if (idPart === '*') {
    if (scopePart !== undefined) {
      throw new Error(
        `Invalid conflict URI '${raw}': wildcard 'conflict://*' does not accept a scope segment. Drop '/${scopePart}' or use a numeric id.`,
      )
    }
    return { id: '*' }
  }
  if (!/^\d+$/.test(idPart)) {
    throw new Error(
      `Invalid conflict URI '${raw}': must be 'conflict://<N>', 'conflict://<N>/<scope>', or 'conflict://*' where N is a positive integer surfaced by a prior read.`,
    )
  }
  const id = Number.parseInt(idPart, 10)
  if (!Number.isFinite(id) || id < 1) {
    throw new Error(`Invalid conflict URI '${raw}': id must be >= 1.`)
  }

  let scope: ConflictScope | undefined
  if (scopePart !== undefined) {
    if (!CONFLICT_SCOPES.has(scopePart)) {
      throw new Error(
        `Invalid conflict URI '${raw}': scope must be one of 'ours', 'theirs', 'base', or omitted (e.g. 'conflict://${id}/theirs').`,
      )
    }
    scope = scopePart as ConflictScope
  }
  return { id, scope }
}

// ===== 内容展开与 splice =====

function normalizeTrailingNewline(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2)
  if (text.endsWith('\n')) return text.slice(0, -1)
  return text
}

/**
 * 把写 content 拆成替换行，展开 `@ours` / `@theirs` / `@base` / `@both` 行
 * 简写。token 仅在整行恰好是它时触发（CRLF 已归一），代码里出现的 `@ours`
 * 字面量不受影响。其余行原样保留。
 *
 * 保持行列表形态（而非 join 成文本）：空 section 展开后贡献 0 行（纯 token
 * 内容得到 []，splice 直接删除区块），而调用方敲的空行（含空 content）始终
 * 是 1 个 '' 行——两者在 join 后无法区分，但 splice 语义不同。
 */
function expandContentTokens(content: string, entry: ConflictEntry): string[] {
  const out: string[] = []
  for (const rawLine of normalizeTrailingNewline(content).split('\n')) {
    const line = stripTrailingCr(rawLine)
    switch (line) {
      case '@ours':
        out.push(...entry.oursLines)
        break
      case '@theirs':
        out.push(...entry.theirsLines)
        break
      case '@base':
        if (!entry.baseLines) {
          throw new Error(
            `Conflict #${entry.id} has no base section (2-way merge). '@base' is only valid for diff3 conflicts.`,
          )
        }
        out.push(...entry.baseLines)
        break
      case '@both':
        out.push(...entry.oursLines, ...entry.theirsLines)
        break
      default:
        out.push(line)
    }
  }
  return out
}

/**
 * 把 entry 记录的标记块从 originalText 中 splice 掉，换成 replacementLines
 * （含标记与三段 body 整块替换；空数组=整块删除不留行，['']=留一个空行）。
 *
 * 按内容定位（记录行号优先，其次最近匹配）：文件上方被 out-of-band 插入/
 * 删除行导致行号漂移不影响解决；但标记块本身被改动/删除则抛错拒绝写入——
 * 这是写前的磁盘校验守卫。CRLF 文件往返：记录行 LF 规范化，写回时按命中
 * 区块的行尾风格补 \r。
 */
function spliceConflict(
  originalText: string,
  entry: ConflictEntry,
  replacementLines: readonly string[],
): string {
  const lines = originalText.split('\n')
  const expected = buildRecordedRegion(entry)
  const match = locateRegion(lines, expected, entry.startLine - 1)
  if (!match) {
    throw new Error(
      `Conflict #${entry.id} is no longer present in ${entry.absolutePath}: the recorded marker block cannot be located. ` +
        'The file changed since the conflict was registered — re-read it to re-register conflicts.',
    )
  }

  let spliced = [...replacementLines]
  const hasFollowingLine = match.endIdx + 1 < lines.length
  if ((lines[match.startIdx] ?? '').endsWith('\r')) {
    spliced = spliced.map((line, i) =>
      i < spliced.length - 1 || hasFollowingLine ? `${line}\r` : line,
    )
  }
  const before = lines.slice(0, match.startIdx)
  // 区块恰在文件尾且被整体删除：上一行成为新的末行，不能保留旧的 \r
  if (spliced.length === 0 && !hasFollowingLine && before.length > 0) {
    before[before.length - 1] = stripTrailingCr(before[before.length - 1] ?? '')
  }
  return [...before, ...spliced, ...lines.slice(match.endIdx + 1)].join('\n')
}

// ===== 解决入口（写通道） =====

/** resolveConflict 的上下文：会话 id 定位注册表，cwd 用于展示相对路径。 */
interface ConflictWriteContext {
  cwd: string
  sessionId: string
}

/** 绝对路径按 cwd 展示为相对路径（越界回退绝对路径）。 */
export function displayPath(absolutePath: string, cwd: string): string {
  const rel = relative(cwd, absolutePath)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : absolutePath
}

/**
 * 解决一个冲突（`conflict://<N>` 写）或全部已注册冲突（`conflict://*` 写）。
 * 返回人类可读的结果摘要；失败抛错（由 resolver 包装成 error result）。
 */
async function resolveConflict(
  target: number | '*',
  content: string,
  ctx: ConflictWriteContext,
): Promise<string> {
  return target === '*'
    ? resolveAllConflicts(content, ctx)
    : resolveOneConflict(target, content, ctx)
}

async function resolveOneConflict(
  id: number,
  content: string,
  ctx: ConflictWriteContext,
): Promise<string> {
  // 写前先复检磁盘（stale/漂移在此暴露），再展开简写、按记录内容 splice
  const entry = await requireConflictEntry(ctx.sessionId, id)
  let original: string
  try {
    original = await readFile(entry.absolutePath, 'utf-8')
  } catch (error) {
    throw new Error(`Conflict #${id} target no longer exists: ${errorMessage(error)}`)
  }
  const replacement = expandContentTokens(content, entry)
  const next = spliceConflict(original, entry, replacement)
  await writeFile(entry.absolutePath, next, 'utf-8')

  // 写回后重扫：退役已解 id、把同文件其余已注册块跟随行漂移重定位
  const registry = getConflictRegistry(ctx.sessionId)
  registry.invalidate(id)
  const remaining = scanConflictMarkers(next.split('\n'), 1)
  registry.reconcileScanned(entry.absolutePath, remaining)

  const display = displayPath(entry.absolutePath, ctx.cwd)
  const range =
    entry.startLine === entry.endLine
      ? `line ${entry.startLine}`
      : `lines ${entry.startLine}-${entry.endLine}`
  const restNote =
    remaining.length > 0 ? ` ${remaining.length} unresolved conflict(s) remain in the file.` : ''
  return `Resolved conflict #${id} at ${range} in ${display}.${restNote}`
}

/** `<id>: @side`（容忍复制的 `LINE:`/`#` 前缀，如 `40:#4 = @ours`）。 */
const BULK_DIRECTIVE_RE = /^(?:\d+:)?#?(\d+)\s*[:=]\s*(@ours|@theirs|@base|@both)$/
/** per-id 指令行头（`<id>:` / `<id>=`，值是否合法不论）——用于识别「想写
 *  per-id 字面量块」的形态并给出更尖的错误信息。 */
const BULK_DIRECTIVE_HEAD_RE = /^(?:\d+:)?#?(\d+)\s*[:=]/

function truncateDirectiveLine(line: string): string {
  return line.length > 60 ? `${line.slice(0, 57)}…` : line
}

/**
 * 解析 `conflict://*` 的 per-id 指令内容：所有非空行都必须是 `<id>: @side`。
 *
 * 返回 null 表示「不是 per-id 块」→ 调用方降级为统一模式（同一 content 写
 * 进每个块）。重复 id 抛错；关键守卫：内容「看起来像」per-id 块但混入了非
 * 指令行、或全是 `<id>: <字面量>` 形态时抛错——omp 实证过没有该守卫时，
 * 这类内容会静默降级成统一模式，把指令文本原样贴进每个冲突块还报告成功。
 */
function parseBulkDirectives(
  content: string,
  registeredIds: ReadonlySet<number>,
): Map<number, string> | null {
  const map = new Map<number, string>()
  const stray: string[] = []
  let sawDirective = false
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    const match = line.match(BULK_DIRECTIVE_RE)
    if (!match) {
      stray.push(line)
      continue
    }
    sawDirective = true
    const id = Number.parseInt(match[1] ?? '', 10)
    if (map.has(id)) {
      throw new Error(`Bulk directive lists conflict #${id} twice — each id may appear once.`)
    }
    map.set(id, match[2] ?? '')
  }
  if (!sawDirective) {
    // 一条合法指令都没有：可能是统一内容，也可能是「首行就以已注册 id 开头
    // 的 per-id 字面量块」。识别特征：首行头指向已注册 id，且没有任何头指向
    // 未注册 id（复制的 LINE: 行头不含数字时不构成头），并且要么所有行都是
    // 已注册头、要么至少两个不同已注册 id 出头。命中即按「畸形 per-id 块」
    // 报错，不降级。
    const heads = stray.map((line) => {
      const head = line.match(BULK_DIRECTIVE_HEAD_RE)
      return head ? Number.parseInt(head[1] ?? '', 10) : undefined
    })
    const registeredHeads = heads.filter((id) => id !== undefined && registeredIds.has(id))
    const literalPerIdBlock =
      heads[0] !== undefined &&
      registeredIds.has(heads[0]) &&
      heads.every((id) => id === undefined || registeredIds.has(id)) &&
      (registeredHeads.length === heads.length || new Set(registeredHeads).size >= 2)
    if (!literalPerIdBlock) return null
  }
  if (stray.length > 0) {
    const sample = stray[0] ?? ''
    const tokenHint = BULK_DIRECTIVE_HEAD_RE.test(sample)
      ? 'Per-id bulk only accepts the tokens @ours/@theirs/@base/@both — one side per id, single line. '
      : ''
    throw new Error(
      `Malformed 'conflict://*' per-id block: ${stray.length} line(s) are not '<id>: @side' directives (first: '${truncateDirectiveLine(sample)}'). ` +
        tokenHint +
        "Literal or multi-line replacement content isn't supported in a per-id block — resolve those blocks with individual 'conflict://<N>' writes. " +
        "For a pure pick-a-side pass, make every non-empty line '<id>: @ours' (or @theirs/@base/@both).",
    )
  }
  return map
}

/**
 * 批量解决（`conflict://*` 写）。先全量复检注册表；content 若是纯
 * `<id>: @side` 指令块则按 id 各解各的（未列出的保持注册），否则作为统一
 * content 写进每个已注册块（token 按各块自己的 section 展开——`@ours` 不是
 * 「第一个块的 ours」）。
 *
 * 文件内 all-or-nothing：按记录行号倒序逐块 splice，任一块失败则该文件
 * 整体不动（注册表原样保留供重试）；成功的文件照常落盘。
 */
async function resolveAllConflicts(content: string, ctx: ConflictWriteContext): Promise<string> {
  const registry = getConflictRegistry(ctx.sessionId)
  const paths = [...new Set(registry.entries().map((entry) => entry.absolutePath))]
  await Promise.all(paths.map((path) => registry.reconcile(path)))
  const all = registry.entries()
  if (all.length === 0) {
    throw new Error(
      "'conflict://*' has nothing to resolve — no conflicts are currently registered. Re-read the conflicted file(s) first.",
    )
  }

  const known = new Set(all.map((entry) => entry.id))
  const directives = parseBulkDirectives(content, known)
  if (directives) {
    const unknown = [...directives.keys()].filter((id) => !known.has(id))
    if (unknown.length > 0) {
      throw new Error(
        `Bulk directive references unknown conflict id(s) ${unknown.map((id) => `#${id}`).join(', ')}. ` +
          `Currently registered: ${all.map((entry) => `#${entry.id}`).join(', ')}.`,
      )
    }
  }
  const selected = directives ? all.filter((entry) => directives.has(entry.id)) : all
  const contentFor = (entry: ConflictEntry): string => directives?.get(entry.id) ?? content

  const byFile = new Map<string, ConflictEntry[]>()
  for (const entry of selected) {
    const bucket = byFile.get(entry.absolutePath) ?? []
    bucket.push(entry)
    byFile.set(entry.absolutePath, bucket)
  }

  const succeeded: { display: string; count: number }[] = []
  const failed: { display: string; count: number; error: string }[] = []
  let resolvedTotal = 0

  for (const [absolutePath, fileEntries] of byFile) {
    const display = displayPath(absolutePath, ctx.cwd)
    let text: string
    try {
      text = await readFile(absolutePath, 'utf-8')
    } catch (error) {
      failed.push({ display, count: fileEntries.length, error: errorMessage(error) })
      continue
    }
    const ordered = [...fileEntries].sort((a, b) => b.startLine - a.startLine)
    const resolved: ConflictEntry[] = []
    let failure: string | undefined
    for (const entry of ordered) {
      try {
        text = spliceConflict(text, entry, expandContentTokens(contentFor(entry), entry))
        resolved.push(entry)
      } catch (error) {
        failure = errorMessage(error)
        break
      }
    }
    if (failure !== undefined) {
      failed.push({ display, count: fileEntries.length, error: failure })
      continue
    }
    await writeFile(absolutePath, text, 'utf-8')
    for (const entry of resolved) registry.invalidate(entry.id)
    registry.reconcileScanned(absolutePath, scanConflictMarkers(text.split('\n'), 1))
    succeeded.push({ display, count: resolved.length })
    resolvedTotal += resolved.length
  }

  const lines: string[] = []
  const conflictWord = (n: number) => (n === 1 ? 'conflict' : 'conflicts')
  if (succeeded.length > 0) {
    lines.push(
      `Resolved ${resolvedTotal} ${conflictWord(resolvedTotal)} across ${succeeded.length} file(s):`,
    )
    for (const file of succeeded)
      lines.push(`  ${file.display}: ${file.count} ${conflictWord(file.count)}`)
  }
  if (directives) {
    const remaining = registry
      .entries()
      .filter((entry) => !directives.has(entry.id))
      .map((entry) => `#${entry.id}`)
    if (remaining.length > 0) {
      lines.push(
        `Directive mode: ${remaining.length} unlisted ${conflictWord(remaining.length)} still registered (${remaining.join(', ')}).`,
      )
    }
  }
  if (failed.length > 0) {
    lines.push(
      `Failed to resolve ${failed.length} file(s) — registered entries left intact for retry:`,
    )
    for (const file of failed) {
      lines.push(`  ${file.display}: ${file.count} ${conflictWord(file.count)} (${file.error})`)
    }
  }
  const summary = lines.join('\n')
  if (failed.length > 0 && succeeded.length === 0) throw new Error(summary)
  return summary
}

// ===== 渲染 =====

/**
 * 渲染冲突块（或其单侧视图）为带原始文件行号的行。bare 返回完整标记块；
 * scoped 只返回该侧 body（base 对 2-way 冲突抛错）。
 */
function renderConflictRegion(
  entry: ConflictEntry,
  scope: ConflictScope | undefined,
): { lines: string[]; startLine: number } {
  if (scope === 'ours') {
    return { lines: [...entry.oursLines], startLine: entry.startLine + 1 }
  }
  if (scope === 'theirs') {
    return { lines: [...entry.theirsLines], startLine: entry.separatorLine + 1 }
  }
  if (scope === 'base') {
    if (entry.baseLines === undefined || entry.baseLine === undefined) {
      throw new Error(
        `Conflict #${entry.id} has no base section (2-way merge). 'conflict://${entry.id}/base' is only valid for diff3 conflicts.`,
      )
    }
    return { lines: [...entry.baseLines], startLine: entry.baseLine + 1 }
  }
  const out: string[] = []
  out.push(entry.oursLabel ? `${OURS_PREFIX} ${entry.oursLabel}` : OURS_PREFIX)
  out.push(...entry.oursLines)
  if (entry.baseLines !== undefined) {
    out.push(entry.baseLabel ? `${BASE_PREFIX} ${entry.baseLabel}` : BASE_PREFIX)
    out.push(...entry.baseLines)
  }
  out.push(SEPARATOR)
  out.push(...entry.theirsLines)
  out.push(entry.theirsLabel ? `${THEIRS_PREFIX} ${entry.theirsLabel}` : THEIRS_PREFIX)
  return { lines: out, startLine: entry.startLine }
}

/**
 * read 输出尾部的冲突 footer：列出本轮注册的 id 与行号区间，并给出
 * conflict:// 的查看/解决用法（含简写与批量形态）。空列表返回 ''。
 */
function formatConflictFooter(entries: readonly ConflictEntry[]): string {
  if (entries.length === 0) return ''
  const list = entries
    .map((entry) => {
      const range =
        entry.startLine === entry.endLine
          ? `L${entry.startLine}`
          : `L${entry.startLine}-L${entry.endLine}`
      return `#${entry.id} (${range})`
    })
    .join(', ')
  const labels: string[] = []
  const oursLabel = entries.find((entry) => entry.oursLabel?.trim())?.oursLabel
  const theirsLabel = entries.find((entry) => entry.theirsLabel?.trim())?.theirsLabel
  if (oursLabel) labels.push(`ours = ${oursLabel}`)
  if (theirsLabel) labels.push(`theirs = ${theirsLabel}`)
  const labelNote = labels.length > 0 ? ` [${labels.join(', ')}]` : ''
  return [
    `[conflict] file has ${entries.length} unresolved conflict(s): ${list}${labelNote}`,
    'Inspect with read conflict://<id> (add /ours, /theirs or /base for one side). ' +
      'Resolve with write conflict://<id> — content replaces ONLY the marker block (never repeat surrounding lines); ' +
      'a line that is exactly @ours/@theirs/@base/@both expands to that recorded side. ' +
      'Bulk: write conflict://* applies content to every registered block, or per-id lines like "1: @ours".',
  ].join('\n')
}

export {
  type ConflictBlock,
  type ConflictEntry,
  ConflictRegistry,
  type ConflictScope,
  type ConflictWriteContext,
  expandContentTokens,
  formatConflictFooter,
  getConflictRegistry,
  type ParsedConflictUri,
  parseConflictUri,
  registerConflicts,
  renderConflictRegion,
  requireConflictEntry,
  resolveConflict,
  scanConflictMarkers,
  spliceConflict,
}
