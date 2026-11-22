// lsp / lsp_rename 工具：把语言服务器能力（诊断/hover/定义/引用/符号/rename）
// 暴露给 agent。协议与生命周期在 src/lsp/（client/manager/servers），本文件只做
// 入参解析、symbol→列号定位、结果格式化与（rename 的）落盘。
//
// 定位口径：LSP 位置 0-based、character 为 UTF-16 code unit——JS string 原生即
// UTF-16，行切分后 char 索引直用。symbol 匹配规则见 parseSymbolSpec/resolveSymbolPosition。

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { loadConfig } from '../../core/config.js'
import { normalizeLocations } from '../../lsp/client.js'
import { defaultLspManager } from '../../lsp/manager.js'
import {
  findWorkspaceRoot,
  pickServersForFile,
  resolveBinary,
  resolveServers,
} from '../../lsp/servers.js'
import type {
  LspClient,
  LspDiagnostic,
  LspLocation,
  LspRange,
  LspServerDef,
  LspTextEdit,
  LspWorkspaceEdit,
} from '../../lsp/types.js'
import { extensionOf, uriToPath } from '../../lsp/types.js'
import { sleep } from '../../shared/timer.js'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import { displayPath } from '../../shared/utils/path.js'
import { errorMessage } from '../../shared/utils/string.js'
import { fail, run } from './tool-result.js'

// ── 常量 ──

const LSP_ACTIONS = [
  'diagnostics',
  'definition',
  'type_definition',
  'references',
  'hover',
  'symbols',
  'status',
] as const
type LspAction = (typeof LSP_ACTIONS)[number]
/** definition/typeDefinition/references/hover 需要 file+line+symbol 三元组。 */
const POSITION_ACTIONS: ReadonlySet<string> = new Set([
  'definition',
  'type_definition',
  'references',
  'hover',
])

const DEFAULT_TIMEOUT_S = 30
const MIN_TIMEOUT_S = 5
const MAX_TIMEOUT_S = 120
/** references 空结果/仅声明命中时的重试（服务器冷启动索引未就绪）。 */
const REFERENCES_RETRIES = 2
const REFERENCES_RETRY_DELAY_MS = 250
const MAX_REFERENCE_RESULTS = 50
/** 诊断新鲜度等待上限：独立于请求超时——从不 publish 的服务器不该让每次
 *  diagnostics 调用都等满 30s，10s 未采信即按「可能过期」返回缓存。 */
const MAX_DIAGNOSTICS_WAIT_MS = 10_000

const SEVERITY_NAMES: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }
const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: 'File',
  2: 'Module',
  3: 'Namespace',
  4: 'Package',
  5: 'Class',
  6: 'Method',
  7: 'Property',
  8: 'Field',
  9: 'Constructor',
  10: 'Enum',
  11: 'Interface',
  12: 'Function',
  13: 'Variable',
  14: 'Constant',
  15: 'String',
  16: 'Number',
  17: 'Boolean',
  18: 'Array',
  19: 'Object',
  20: 'Key',
  21: 'Null',
  22: 'EnumMember',
  23: 'Struct',
  24: 'Event',
  25: 'Operator',
  26: 'TypeParameter',
}

/** timeout 秒 → 毫秒，clamp 到 [5,120]；缺省 30。 */
function clampTimeoutMs(timeout: unknown): number {
  if (timeout === undefined || timeout === null) return DEFAULT_TIMEOUT_S * 1000
  const s = typeof timeout === 'number' ? timeout : Number(timeout)
  if (!Number.isFinite(s)) return DEFAULT_TIMEOUT_S * 1000
  return Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, s)) * 1000
}

// ── symbol → 列号定位 ──

const BARE_IDENTIFIER_RE = /^[$A-Za-z_][\w$]*$/
const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_$]/

/**
 * 解析 `name` / `name#N`：#N 表示该行第 N 次出现（1-based）。贪婪 `.+` 使
 * `#field#2` 解析为 symbol `#field`、occurrence 2（TS 私有字段名）。
 */
function parseSymbolSpec(spec: string): { symbol: string; occurrence: number } {
  const m = spec.match(/^(.+)#(\d+)$/)
  if (!m) return { symbol: spec, occurrence: 1 }
  return { symbol: m[1] as string, occurrence: Math.max(1, Number.parseInt(m[2] as string, 10)) }
}

/**
 * symbol 在行内的全部匹配列号：裸标识符要求前后是词边界（`foo` 不匹配
 * `foobar`）；含非标识符字符（`obj.prop`、`#field` 等）退化为子串匹配。
 */
function findSymbolMatchIndexes(lineText: string, symbol: string): number[] {
  if (symbol.length === 0) return []
  const wordMode = BARE_IDENTIFIER_RE.test(symbol)
  const indexes: number[] = []
  let from = 0
  for (;;) {
    const idx = lineText.indexOf(symbol, from)
    if (idx < 0) break
    const afterIdx = idx + symbol.length
    from = afterIdx
    if (wordMode) {
      const before = idx > 0 ? (lineText[idx - 1] ?? '') : ''
      const after = afterIdx < lineText.length ? (lineText[afterIdx] ?? '') : ''
      if (IDENTIFIER_CHAR_RE.test(before) || IDENTIFIER_CHAR_RE.test(after)) continue
    }
    indexes.push(idx)
  }
  return indexes
}

/** 读文件并把 symbol 定位到 0-based (line, character)。失败时抛带行内容的错。 */
async function resolveSymbolPosition(
  absPath: string,
  line: number,
  symbolSpec: string,
): Promise<{ line0: number; character0: number }> {
  let text: string
  try {
    text = await readFile(absPath, 'utf8')
  } catch (e) {
    throw new Error(`cannot read ${absPath}: ${errorMessage(e)}`)
  }
  const lines = text.split('\n')
  const line0 = line - 1
  const lineText = lines[line0]
  if (lineText === undefined) {
    throw new Error(`line ${line} is out of range: ${absPath} has ${lines.length} line(s)`)
  }
  const { symbol, occurrence } = parseSymbolSpec(symbolSpec)
  // 大小写精确优先；精确无命中再放宽到大小写不敏感（toLowerCase 对代码内
  // ASCII 标识符长度不变，索引可直接用于原文）。
  const exact = findSymbolMatchIndexes(lineText, symbol)
  const matches =
    exact.length > 0 ? exact : findSymbolMatchIndexes(lineText.toLowerCase(), symbol.toLowerCase())
  const hint = `Line ${line}: ${JSON.stringify(lineText)}\nPass the symbol exactly as it appears (bare identifiers must match whole words; append #N to pick the Nth occurrence).`
  if (matches.length === 0) {
    throw new Error(`symbol "${symbol}" not found on line ${line} of ${absPath}.\n${hint}`)
  }
  if (occurrence > matches.length) {
    throw new Error(
      `symbol "${symbol}" occurrence #${occurrence} is out of range: line ${line} of ${absPath} has ${matches.length} match(es).\n${hint}`,
    )
  }
  return { line0, character0: matches[occurrence - 1] as number }
}

// ── 输出格式化 ──

/** ±1 行上下文（`    N | text`）；文件不可读返回 []（如已删除的定义位置）。 */
async function contextLines(absPath: string, line0: number): Promise<string[]> {
  try {
    const lines = (await readFile(absPath, 'utf8')).split('\n')
    const out: string[] = []
    for (let i = Math.max(0, line0 - 1); i <= Math.min(lines.length - 1, line0 + 1); i++) {
      out.push(`    ${i + 1} | ${lines[i]}`)
    }
    return out
  } catch {
    return []
  }
}

async function formatLocation(loc: LspLocation, cwd: string): Promise<string> {
  const path = uriToPath(loc.uri)
  const head = `  ${displayPath(path, cwd)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`
  const ctx = await contextLines(path, loc.range.start.line)
  return ctx.length > 0 ? `${head}\n${ctx.join('\n')}` : head
}

/** hover contents（string | MarkedString | MarkupContent | 数组）摊平为纯文本。 */
function extractHoverText(contents: unknown): string {
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents
      .map((c) => extractHoverText(c))
      .filter((s) => s !== '')
      .join('\n')
  }
  if (contents && typeof contents === 'object' && 'value' in contents) {
    return String((contents as { value: unknown }).value)
  }
  return ''
}

function symbolKindName(kind: unknown): string {
  return typeof kind === 'number' && SYMBOL_KIND_NAMES[kind] ? SYMBOL_KIND_NAMES[kind] : 'Unknown'
}

/** documentSymbol 结果扁平化：DocumentSymbol（有 selectionRange）按层级缩进，
 *  SymbolInformation（有 location）平铺；输出 `name kind line` 缩进树。 */
function flattenSymbols(symbols: unknown, depth: number, out: string[]): void {
  if (!Array.isArray(symbols)) return
  for (const s of symbols) {
    if (!s || typeof s !== 'object') continue
    const item = s as Record<string, unknown>
    if (item.selectionRange && typeof item.selectionRange === 'object') {
      const range = item.selectionRange as LspRange
      out.push(
        `${'  '.repeat(depth)}${item.name} ${symbolKindName(item.kind)} ${(range.start?.line ?? 0) + 1}`,
      )
      flattenSymbols(item.children, depth + 1, out)
    } else if (item.location && typeof item.location === 'object') {
      const range = (item.location as LspLocation).range
      out.push(
        `${'  '.repeat(depth)}${item.name} ${symbolKindName(item.kind)} ${(range.start?.line ?? 0) + 1}`,
      )
    }
  }
}

function severityName(sev: unknown): string {
  return typeof sev === 'number' && SEVERITY_NAMES[sev] ? SEVERITY_NAMES[sev] : 'info'
}

/** severity 缺省按 info（rank 3）参与排序。 */
function severityRank(sev: unknown): number {
  return typeof sev === 'number' && sev >= 1 && sev <= 4 ? sev : 3
}

/** 按 severity（error>warning>info>hint）→ 位置 排序；range+source+message 去重。 */
function sortDedupeDiagnostics(list: LspDiagnostic[]): LspDiagnostic[] {
  const seen = new Set<string>()
  const out: LspDiagnostic[] = []
  for (const d of list) {
    const key = `${d.range?.start?.line}:${d.range?.start?.character}:${d.range?.end?.line}:${d.range?.end?.character}:${d.source ?? ''}:${d.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(d)
  }
  out.sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity)
    if (bySeverity !== 0) return bySeverity
    const byLine = (a.range?.start?.line ?? 0) - (b.range?.start?.line ?? 0)
    if (byLine !== 0) return byLine
    return (a.range?.start?.character ?? 0) - (b.range?.start?.character ?? 0)
  })
  return out
}

function formatDiagnostics(list: LspDiagnostic[]): string[] {
  const out: string[] = []
  let currentSeverity = ''
  for (const d of list) {
    const name = severityName(d.severity)
    if (name !== currentSeverity) {
      currentSeverity = name
      out.push(`${name}:`)
    }
    const { start, end } = d.range
    const span = `${(start?.line ?? 0) + 1}:${(start?.character ?? 0) + 1}-${(end?.line ?? 0) + 1}:${(end?.character ?? 0) + 1}`
    out.push(`  ${span} ${d.source ? `[${d.source}] ` : ''}${d.message}`)
  }
  return out
}

// ── 服务器解析 ──

type ServerTarget = { server: LspServerDef; workspaceRoot: string }

function noServerMessage(servers: LspServerDef[], absPath: string): string {
  const listing = servers.map(
    (s) => `- ${s.name} [.${s.fileTypes.join(' .')}] (command: ${s.command})`,
  )
  const configured = listing.length > 0 ? listing.join('\n') : '(no servers configured)'
  return [
    `no language server is configured for "${absPath}" (extension ".${extensionOf(absPath) || '?'}").`,
    `Configured servers:`,
    configured,
    'Add/override a server via config `lsp.servers.<name>` (command/args/fileTypes/rootMarkers) or remove an entry with `disabled: true`.',
  ].join('\n')
}

/**
 * 解析 absPath 可用的服务器：按扩展名匹配 + 二进制定位（node_modules/.bin
 * 优先，其次 PATH）。全缺失时抛带安装指引的错；每个 target 附 workspaceRoot。
 */
async function acquireTargets(
  servers: LspServerDef[],
  absPath: string,
): Promise<Array<ServerTarget & { client: LspClient }>> {
  const matched = pickServersForFile(servers, absPath)
  if (matched.length === 0) throw new Error(noServerMessage(servers, absPath))
  const targets: ServerTarget[] = []
  const missing: string[] = []
  for (const server of matched) {
    const workspaceRoot = findWorkspaceRoot(dirname(absPath), server.rootMarkers)
    if (!resolveBinary(server.command, workspaceRoot)) {
      missing.push(
        `- ${server.name}: command "${server.command}" not found (checked ${workspaceRoot}/node_modules/.bin and PATH)`,
      )
      continue
    }
    targets.push({ server, workspaceRoot })
  }
  if (targets.length === 0) {
    throw new Error(
      [
        'language server binary not found for this file:',
        ...missing,
        'Install it in the workspace (e.g. `npm install -D typescript-language-server typescript`) so it lands in node_modules/.bin, or make it available on PATH.',
      ].join('\n'),
    )
  }
  const withClients = []
  for (const target of targets) {
    withClients.push({
      ...target,
      client: await defaultLspManager.acquire(target.server, target.workspaceRoot),
    })
  }
  return withClients
}

function positionParams(
  uri: string,
  pos: { line0: number; character0: number },
): Record<string, unknown> {
  return {
    textDocument: { uri },
    position: { line: pos.line0, character: pos.character0 },
  }
}

/** references 重试条件：空结果，或唯一命中即查询点自身（声明处）——多为索引未就绪。 */
function isOnlyDeclarationSite(
  locations: LspLocation[],
  uri: string,
  pos: { line0: number; character0: number },
): boolean {
  if (locations.length !== 1) return false
  const loc = locations[0] as LspLocation
  if (loc.uri !== uri) return false
  const s = loc.range.start
  const e = loc.range.end
  return (
    s.line <= pos.line0 &&
    (s.line < pos.line0 || s.character <= pos.character0) &&
    e.line >= pos.line0 &&
    (e.line > pos.line0 || e.character >= pos.character0)
  )
}

// ── lsp 工具 ──

const lspDescription = `Query language servers (LSP) for code intelligence.
Provide the triple (file, line, symbol): line is 1-based; symbol is the text on that line — bare identifiers must match a whole word (foo does not match foobar), anything else matches as a substring; case-sensitive matches win over case-insensitive ones; append #N to pick the Nth occurrence on the line (name#2).
Actions:
- diagnostics: fresh diagnostics for a file (sorted error > warning > info, deduped; "OK" when clean). No line/symbol needed.
- definition / type_definition: where the symbol is declared (file:line:col with +/-1 context lines).
- references: all usages (includeDeclaration). Retries twice when the server is still indexing; first 50 results.
- hover: type/signature info at the symbol as plain text.
- symbols: document symbol outline (name kind line, indented tree).
- status: configured servers, their file types, and whether the binary is available (file not required).
Servers resolve from config lsp.servers (built-in defaults: typescript-language-server, pyright, gopls, clangd, rust-analyzer); the binary is looked up in <workspaceRoot>/node_modules/.bin first, then PATH.`

const lspTool: ToolDef = {
  name: 'lsp',
  description: lspDescription,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...LSP_ACTIONS], description: 'Query to run.' },
      file: {
        type: 'string',
        description: 'Target file (cwd-relative or absolute). Optional for action=status.',
      },
      line: {
        type: 'integer',
        description:
          '1-based line number (required for definition/type_definition/references/hover).',
      },
      symbol: {
        type: 'string',
        description: 'Symbol text on that line; append #N for the Nth occurrence (e.g. handle#2).',
      },
      timeout: {
        type: 'number',
        description: 'Per-request timeout in seconds, 5-120 (default 30).',
      },
    },
    required: ['action'],
  },
  permission: 'auto',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const i = input as {
      action?: string
      file?: string
      line?: number
      symbol?: string
      timeout?: number
    }
    if (!i.action || !(LSP_ACTIONS as readonly string[]).includes(i.action)) {
      return fail(
        `lsp: invalid action ${JSON.stringify(i.action)}; expected one of ${LSP_ACTIONS.join(' | ')}`,
      )
    }
    const action = i.action as LspAction
    const timeoutMs = clampTimeoutMs(i.timeout)
    const needsPosition = POSITION_ACTIONS.has(action)
    if (action !== 'status' && !i.file) return fail('lsp: "file" is required for this action')
    if (needsPosition) {
      if (!i.line || !Number.isInteger(i.line) || i.line < 1)
        return fail(`lsp: "line" (1-based integer) is required for action "${action}"`)
      if (!i.symbol || typeof i.symbol !== 'string')
        return fail(`lsp: "symbol" is required for action "${action}"`)
    }
    return run('lsp', async () => {
      const config = await loadConfig(ctx.cwd)
      const servers = resolveServers(config)
      if (action === 'status') return formatStatus(servers, ctx.cwd)

      const absPath = isAbsolute(i.file as string)
        ? (i.file as string)
        : resolve(ctx.cwd, i.file as string)
      const targets = await acquireTargets(servers, absPath)
      const sections: string[] = []

      if (action === 'symbols') {
        for (const { server, client } of targets) {
          const rec = await client.reconcileFromDisk(absPath)
          const raw = await client.request(
            'textDocument/documentSymbol',
            { textDocument: { uri: rec.uri } },
            timeoutMs,
          )
          const lines: string[] = []
          flattenSymbols(raw, 0, lines)
          sections.push(
            lines.length > 0
              ? `[${server.name}] ${lines.length} symbol(s)\n${lines.join('\n')}`
              : `[${server.name}] no symbols`,
          )
        }
        return sections.join('\n\n')
      }

      if (action === 'diagnostics') {
        let total = 0
        for (const { server, client } of targets) {
          const rec = await client.reconcileFromDisk(absPath)
          const fresh = await client.waitForDiagnostics(
            rec.uri,
            rec.version,
            Math.min(timeoutMs, MAX_DIAGNOSTICS_WAIT_MS),
          )
          const list = sortDedupeDiagnostics(fresh.diagnostics)
          total += list.length
          if (list.length === 0) {
            sections.push(
              `[${server.name}] OK${fresh.stale ? ' (timed out waiting for a fresh publish; may be stale)' : ''}`,
            )
            continue
          }
          const staleNote = fresh.stale
            ? '\n  (timed out waiting for a fresh publish; diagnostics above may be stale)'
            : ''
          sections.push(
            `[${server.name}] (${countBySeverity(list)})\n${formatDiagnostics(list).join('\n')}${staleNote}`,
          )
        }
        return total === 0
          ? `OK — no diagnostics for ${displayPath(absPath, ctx.cwd)}\n\n${sections.join('\n\n')}`
          : sections.join('\n\n')
      }

      // 位置类 action：definition / type_definition / references / hover
      const pos = await resolveSymbolPosition(absPath, i.line as number, i.symbol as string)
      for (const { server, client } of targets) {
        const rec = await client.reconcileFromDisk(absPath)
        const base = positionParams(rec.uri, pos)
        if (action === 'definition' || action === 'type_definition') {
          const method =
            action === 'definition' ? 'textDocument/definition' : 'textDocument/typeDefinition'
          const locations = normalizeLocations(await client.request(method, base, timeoutMs))
          sections.push(
            locations.length === 0
              ? `[${server.name}] no ${action === 'definition' ? 'definition' : 'type definition'} found`
              : `[${server.name}] ${locations.length} location(s)\n${(await Promise.all(locations.map((loc) => formatLocation(loc, ctx.cwd)))).join('\n')}`,
          )
        } else if (action === 'references') {
          const locations = await queryReferences(client, base, rec.uri, pos, timeoutMs)
          if (locations.length === 0) {
            sections.push(
              `[${server.name}] no references found (the server index may still be building)`,
            )
            continue
          }
          const shown = locations.slice(0, MAX_REFERENCE_RESULTS)
          const more =
            locations.length > shown.length ? `\n  (+${locations.length - shown.length} more)` : ''
          sections.push(
            `[${server.name}] ${locations.length} reference(s)\n${(await Promise.all(shown.map((loc) => formatLocation(loc, ctx.cwd)))).join('\n')}${more}`,
          )
        } else {
          const hover = (await client.request('textDocument/hover', base, timeoutMs)) as {
            contents?: unknown
          } | null
          const text = extractHoverText(hover?.contents).trim()
          sections.push(
            text !== ''
              ? `[${server.name}]\n${text}`
              : `[${server.name}] no hover information at ${displayPath(absPath, ctx.cwd)}:${i.line}`,
          )
        }
      }
      return sections.join('\n\n')
    })
  },
}

function countBySeverity(list: LspDiagnostic[]): string {
  const counts = new Map<string, number>()
  for (const d of list)
    counts.set(severityName(d.severity), (counts.get(severityName(d.severity)) ?? 0) + 1)
  return Array.from(counts.entries())
    .map(([name, n]) => `${n} ${name}${n > 1 ? 's' : ''}`)
    .join(', ')
}

/** references：空结果或仅声明命中时重试（服务器索引未就绪），间隔 250ms。 */
async function queryReferences(
  client: LspClient,
  base: Record<string, unknown>,
  uri: string,
  pos: { line0: number; character0: number },
  timeoutMs: number,
) {
  let locations: LspLocation[] = []
  for (let attempt = 0; attempt <= REFERENCES_RETRIES; attempt++) {
    locations = normalizeLocations(
      await client.request(
        'textDocument/references',
        { ...base, context: { includeDeclaration: true } },
        timeoutMs,
      ),
    )
    if (locations.length > 0 && !isOnlyDeclarationSite(locations, uri, pos)) break
    if (attempt < REFERENCES_RETRIES) await sleep(REFERENCES_RETRY_DELAY_MS)
  }
  return locations
}

function formatStatus(servers: LspServerDef[], cwd: string): string {
  const lines = [`LSP servers resolved from config (cwd: ${cwd}):`]
  if (servers.length === 0) lines.push('(none configured)')
  for (const server of servers) {
    const workspaceRoot = findWorkspaceRoot(cwd, server.rootMarkers)
    const binary = resolveBinary(server.command, workspaceRoot)
    const binaryNote = binary
      ? `binary ok (${binary})`
      : `binary missing: "${server.command}" not in ${workspaceRoot}/node_modules/.bin or PATH`
    lines.push(
      `- ${server.name} [${server.fileTypes.map((ft) => `.${ft}`).join(' ')}] root: ${workspaceRoot} — ${binaryNote}`,
    )
  }
  lines.push(
    'Override via config `lsp.servers.<name>` (command/args/fileTypes/rootMarkers/initOptions/settings); disable with `disabled: true`.',
  )
  return lines.join('\n')
}

// ── lsp_rename 工具 ──

/** WorkspaceEdit → 按文件分组的文本编辑 + 不支持的资源操作列表。 */
function flattenRenameEdits(edit: LspWorkspaceEdit): {
  byFile: Map<string, LspTextEdit[]>
  unsupported: string[]
} {
  const byFile = new Map<string, LspTextEdit[]>()
  const unsupported: string[] = []
  const push = (uri: string, edits: unknown): void => {
    if (!Array.isArray(edits) || edits.length === 0) return
    const path = uriToPath(uri)
    const existing = byFile.get(path) ?? []
    existing.push(...(edits as LspTextEdit[]))
    byFile.set(path, existing)
  }
  if (Array.isArray(edit.documentChanges)) {
    for (const change of edit.documentChanges) {
      if (change && typeof change === 'object' && 'kind' in change) {
        unsupported.push(String(change.kind))
      } else if (change && typeof change === 'object' && 'textDocument' in change) {
        const tde = change as { textDocument?: { uri?: string }; edits?: unknown }
        if (tde.textDocument?.uri) push(tde.textDocument.uri, tde.edits)
      }
    }
  }
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) push(uri, edits)
  }
  return { byFile, unsupported }
}

/** 从后往前按 range 应用编辑（UTF-16 char 索引直用；跨行编辑做行拼接）。 */
function applyTextEditsToString(content: string, edits: LspTextEdit[]): string {
  const lines = content.split('\n')
  const sorted = edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => {
      if (a.edit.range.start.line !== b.edit.range.start.line)
        return b.edit.range.start.line - a.edit.range.start.line
      if (a.edit.range.start.character !== b.edit.range.start.character) {
        return b.edit.range.start.character - a.edit.range.start.character
      }
      return b.index - a.index
    })
    .map((entry) => entry.edit)
  for (const edit of sorted) {
    const { start, end } = edit.range
    if (start.line === end.line) {
      const line = lines[start.line] ?? ''
      lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character)
    } else {
      const startLine = lines[start.line] ?? ''
      const endLine = lines[end.line] ?? ''
      const merged =
        startLine.slice(0, start.character) + edit.newText + endLine.slice(end.character)
      lines.splice(start.line, end.line - start.line + 1, ...merged.split('\n'))
    }
  }
  return lines.join('\n')
}

const lspRenameTool: ToolDef = {
  name: 'lsp_rename',
  description:
    'Rename a symbol across the project via the language server (LSP textDocument/rename). Takes the same (file, line, symbol) triple as the lsp tool (symbol rules: whole-word for bare identifiers, substring otherwise, #N picks the Nth occurrence). Set apply=false to only preview the edits; default apply=true writes them to disk and re-syncs the language server.',
  parameters: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'File containing the symbol (cwd-relative or absolute).',
      },
      line: { type: 'integer', description: '1-based line number.' },
      symbol: {
        type: 'string',
        description: 'Symbol text on that line; append #N for the Nth occurrence.',
      },
      new_name: { type: 'string', description: 'New name for the symbol.' },
      apply: {
        type: 'boolean',
        description: 'true (default) writes edits to disk; false only previews them.',
      },
      timeout: {
        type: 'number',
        description: 'Per-request timeout in seconds, 5-120 (default 30).',
      },
    },
    required: ['file', 'line', 'symbol', 'new_name'],
  },
  permission: 'ask',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const i = input as {
      file?: string
      line?: number
      symbol?: string
      new_name?: string
      apply?: boolean
      timeout?: number
    }
    if (!i.file) return fail('lsp_rename: "file" is required')
    if (!i.line || !Number.isInteger(i.line) || i.line < 1)
      return fail('lsp_rename: "line" (1-based integer) is required')
    if (!i.symbol) return fail('lsp_rename: "symbol" is required')
    if (!i.new_name || typeof i.new_name !== 'string')
      return fail('lsp_rename: "new_name" is required')
    const apply = i.apply !== false
    const timeoutMs = clampTimeoutMs(i.timeout)
    return run('lsp_rename', async () => {
      const config = await loadConfig(ctx.cwd)
      const servers = resolveServers(config)
      const absPath = isAbsolute(i.file as string)
        ? (i.file as string)
        : resolve(ctx.cwd, i.file as string)
      const targets = await acquireTargets(servers, absPath)
      const pos = await resolveSymbolPosition(absPath, i.line as number, i.symbol as string)
      // rename 用首个可用服务器（内置各服务器 fileTypes 无交集，多命中罕见）。
      const primary = targets[0] as (typeof targets)[number]
      const rec = await primary.client.reconcileFromDisk(absPath)
      const result = await primary.client.request(
        'textDocument/rename',
        { ...positionParams(rec.uri, pos), newName: i.new_name },
        timeoutMs,
      )
      if (result === null || result === undefined) {
        return `server returned no rename edits at ${displayPath(absPath, ctx.cwd)}:${i.line} (symbol may not be renameable here)`
      }
      const { byFile, unsupported } = flattenRenameEdits(result as LspWorkspaceEdit)
      if (unsupported.length > 0) {
        throw new Error(
          `lsp_rename only supports text edits; the server requested file operation(s): ${unsupported.join(', ')}`,
        )
      }
      const editCount = Array.from(byFile.values()).reduce((n, edits) => n + edits.length, 0)
      if (byFile.size === 0 || editCount === 0) {
        return 'server returned an empty edit set; nothing to rename'
      }

      const previewLines: string[] = []
      for (const [path, edits] of byFile) {
        for (const edit of edits) {
          previewLines.push(
            `  ${displayPath(path, ctx.cwd)}:${edit.range.start.line + 1}:${edit.range.start.character + 1}  ${JSON.stringify(edit.newText)}`,
          )
        }
      }

      if (!apply) {
        return [
          `rename preview (${editCount} edit(s) in ${byFile.size} file(s), NOT applied):`,
          ...previewLines,
        ].join('\n')
      }

      for (const [path, edits] of byFile) {
        const text = await readFile(path, 'utf8')
        await writeFile(path, applyTextEditsToString(text, edits), 'utf8')
      }
      // 落盘后对每个改动文件 reconcile（编辑改变了磁盘内容，需 didChange 同步）。
      const resynced: string[] = []
      for (const path of byFile.keys()) {
        for (const server of pickServersForFile(servers, path)) {
          const workspaceRoot = findWorkspaceRoot(dirname(path), server.rootMarkers)
          if (!resolveBinary(server.command, workspaceRoot)) continue
          const client = await defaultLspManager.acquire(server, workspaceRoot)
          await client.reconcileFromDisk(path)
          resynced.push(`${server.name}:${path}`)
        }
      }
      return [
        `renamed ${JSON.stringify(i.symbol)} → ${JSON.stringify(i.new_name)}: ${editCount} edit(s) in ${byFile.size} file(s)`,
        ...previewLines,
        resynced.length > 0
          ? `\nre-synced language servers: ${Array.from(new Set(resynced)).join(', ')}`
          : '',
      ].join('\n')
    })
  },
}

const lspTools: ToolDef[] = [lspTool, lspRenameTool]

export {
  applyTextEditsToString,
  findSymbolMatchIndexes,
  flattenRenameEdits,
  lspRenameTool,
  lspTool,
  lspTools,
  parseSymbolSpec,
  resolveSymbolPosition,
  sortDedupeDiagnostics,
}
