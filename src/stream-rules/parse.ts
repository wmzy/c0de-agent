// 流规则文件（.md）的 frontmatter 解析。
//
// 刻意手写极简 YAML 子集（与 core/context-files.ts 的 cursor/windsurf 门控
// 解析同风格、不引入 yaml 依赖）：仅支持 `key: value`、inline 数组
// `[a, b]`、块列表（后续缩进 `- item` 行）。已知局限：inline 数组内引号
// 字符串含逗号会被错误切分——条件正则里罕见，出现时用块列表写法即可。

import { basename } from 'node:path'
import type { StreamRule, StreamRuleRepeatMode } from './types.js'

/** 解析结果：ok=false 时 error 为面向诊断的中文原因（调用方据此跳过该文件）。 */
export type StreamRuleParseResult = { ok: true; rule: StreamRule } | { ok: false; error: string }

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

const REPEAT_MODES: readonly StreamRuleRepeatMode[] = ['once', 'turn-gap', 'always']

function isRepeatMode(value: string): value is StreamRuleRepeatMode {
  return (REPEAT_MODES as readonly string[]).includes(value)
}

const DEFAULT_REPEAT_GAP = 10

type FmValue = string | string[]

type Frontmatter = Map<string, FmValue>

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/** inline 数组 `[a, b]` → 逗号切分（先剥引号外的方括号，再逐项剥引号）。 */
function parseInlineList(value: string): string[] {
  const inner = value.slice(1, -1)
  return inner
    .split(',')
    .map((item) => stripQuotes(item.trim()))
    .filter((item) => item.length > 0)
}

/** 单值字段读取（数组形态视为取首项，容忍 `name: [x]` 这类笔误）。 */
function scalarOf(value: FmValue | undefined): string | undefined {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : value[0]
}

/** condition 取值归一：string | string[] → 非空 pattern 列表。 */
function toStringList(value: FmValue | undefined): string[] {
  if (value === undefined) return []
  const raw = typeof value === 'string' ? [value] : value
  return raw.map((item) => stripQuotes(item.trim())).filter((item) => item.length > 0)
}

function parseFrontmatter(raw: string): Frontmatter {
  const fm: Frontmatter = new Map()
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1] ?? ''
    const value = (kv[2] ?? '').trim()
    if (value === '') {
      // 空值可能是块列表头：收集后续缩进的 `- item` 行
      const items: string[] = []
      let j = i + 1
      while (j < lines.length) {
        const item = /^[ \t]+-[ \t]?(.*)$/.exec(lines[j] ?? '')
        if (!item) break
        items.push(stripQuotes((item[1] ?? '').trim()))
        j++
      }
      if (items.length > 0) {
        fm.set(key, items)
        i = j - 1
      } else {
        fm.set(key, '')
      }
      continue
    }
    fm.set(key, /^\[.*\]$/.test(value) ? parseInlineList(value) : stripQuotes(value))
  }
  return fm
}

function defaultRuleName(source: string): string {
  const file = basename(source)
  return file.replace(/\.md$/, '') || 'rule'
}

/**
 * 解析单个规则文件内容。文件级 fail-closed：frontmatter 缺失、condition
 * 缺失/全空、scope 非一期支持的 'text'、repeatMode/repeatGap 非法、任一
 * condition 正则编译失败——均返回 ok=false 让调用方跳过整个文件。
 */
export function parseStreamRule(md: string, source: string): StreamRuleParseResult {
  const fail = (error: string): StreamRuleParseResult => ({ ok: false, error })

  const m = FRONTMATTER_RE.exec(md)
  if (!m) return fail('缺少 frontmatter（需 --- 包裹并声明 condition）')
  const fm = parseFrontmatter(m[1] ?? '')
  const body = md.slice(m[0].length).trim()

  const name = (scalarOf(fm.get('name')) ?? '').trim() || defaultRuleName(source)

  const patterns = toStringList(fm.get('condition'))
  if (patterns.length === 0) return fail('缺少可用的 condition（流规则需至少一个触发正则）')

  const scope = (scalarOf(fm.get('scope')) ?? 'text').trim()
  if (scope !== 'text') return fail(`不支持的 scope "${scope}"（一期仅支持 text）`)

  const repeatMode = (scalarOf(fm.get('repeatMode')) ?? 'once').trim()
  if (!isRepeatMode(repeatMode)) {
    return fail(`非法 repeatMode "${repeatMode}"（可选 once | turn-gap | always）`)
  }

  let repeatGap = DEFAULT_REPEAT_GAP
  const gapRaw = fm.get('repeatGap')
  if (gapRaw !== undefined) {
    const parsed = Number(scalarOf(gapRaw))
    if (!Number.isInteger(parsed) || parsed < 1) {
      return fail(`非法 repeatGap "${String(scalarOf(gapRaw))}"（需 ≥1 的整数）`)
    }
    repeatGap = parsed
  }

  const conditions: RegExp[] = []
  for (const pattern of patterns) {
    try {
      conditions.push(new RegExp(pattern))
    } catch (error) {
      return fail(
        `condition 正则非法：${pattern}（${error instanceof Error ? error.message : String(error)}）`,
      )
    }
  }

  return {
    ok: true,
    rule: { name, conditions, scope: 'text', repeatMode, repeatGap, body, source },
  }
}
