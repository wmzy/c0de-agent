// Magic keywords（对标 oh-my-pi）：用户消息 prose 中的独立关键词（ultrathink /
// orchestrate / workflowz）触发隐藏指令注入——作为 steering 消息插在最后一条
// user 消息之前（同 turn 生效，见 loop 的 steering 插入位），引导该轮的推理与
// 编排行为，不动 system prompt（对 prompt cache 零影响）。
//
// 匹配规则（omp 口径）：
// - 精确小写、standalone prose：字母/数字/_/./-// 等代码字符贴词、函数调用
//   `word(`、符号引用 `foo::word`、复数后缀均不触发；标点与引号可贴词；
//   CJK 字符是合法边界（中文无词间空格）。
// - 围栏代码块、行内代码（shared/utils/markdown-code.ts 的 stripMarkdownCode）
//   与 HTML 注释/标签内的关键词不触发。
// - requires 声明的工具未在本轮启用 → 跳过该关键词（不向模型承诺不存在的能力）。
// - 配置开关：magicKeywords.enabled 总开关 + 每关键词独立开关（id 命名：
//   workflowz 用 'workflow'）。
//
// 注入点：Web chat 路由与 CLI print 模式（含 ACP，共用 print 通道）——用户发起
// 的消息才检测；子 agent / 工作流的合成 prompt 不触发。

import { stripMarkdownCode } from '../shared/utils/markdown-code.js'
import type { Config } from './config.js'
import { buildWorkflowNotice } from './workflow.js'

/** 关键词表条目。单一事实源：加一行即全表面（检测/开关/notice）派生。 */
type MagicKeyword = {
  /** config.magicKeywords.<id> 开关键。 */
  id: 'ultrathink' | 'orchestrate' | 'workflow'
  /** 精确触发词（小写）。 */
  word: string
  /** 必须全部启用的工具名，否则跳过 notice。 */
  requires: readonly string[]
  /** 渲染隐藏 notice 文本。 */
  notice: (ctx: MagicKeywordContext) => string
}

/** notice 渲染上下文（首个命中关键词时才组装）。 */
export type MagicKeywordContext = {
  /** 本轮启用的工具名。 */
  tools: readonly string[]
  /** 可用工作流清单（workflowz 用；空表也有引导文案）。 */
  workflowList: ReadonlyArray<{ name: string; description: string }>
}

const ULTRATHINK_NOTICE = `<system-notice>
The user's message contains the keyword **ultrathink**: they request careful, deliberate multi-step reasoning for this turn. Think the problem through step by step before acting — decompose it, verify assumptions against the actual codebase (read before concluding), consider edge cases and failure modes, and prefer correctness over speed. Do not rush to the first plausible fix.
</system-notice>`

function renderOrchestrateNotice(ctx: MagicKeywordContext): string {
  return `<system-notice>
The user's message contains the keyword **orchestrate**: they want substantial independent work run through parallel sub-agents. Scope the full task first, split it into independent slices (shared contracts/interfaces pinned up front), fan them out concurrently via the \`task\` tool, verify each sub-agent's result yourself, and integrate. Work that can run in parallel MUST NOT be done serially inline. Tools available this turn: ${ctx.tools.join(', ')}.
</system-notice>`
}

const MAGIC_KEYWORDS: readonly MagicKeyword[] = [
  { id: 'ultrathink', word: 'ultrathink', requires: [], notice: () => ULTRATHINK_NOTICE },
  {
    id: 'orchestrate',
    word: 'orchestrate',
    requires: ['task'],
    notice: (ctx) => renderOrchestrateNotice(ctx),
  },
  {
    id: 'workflow',
    word: 'workflowz',
    requires: ['task'],
    notice: (ctx) => buildWorkflowNotice([...ctx.workflowList]),
  },
]

// ── 匹配器 ─────────────────────────────────────────────────

/** 剥离 HTML 注释与标签元素（含元素内容——omp 口径「tags and their contents are
 * ignored」；stripMarkdownCode 不覆盖的剩余非 prose 区）。 */
function stripHtml(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<([A-Za-z][^\s>/]*)[^>]*>[\s\S]*?<\/\1\s*>/g, ' ')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
}

/** standalone 词边界：左侧拒绝 ASCII 词/数字/_/./-// 与 `::` 符号引用；右侧再
 *  拒绝文件扩展名点（word.ts）与函数调用（word(）。标点、引号可贴词；CJK 字符
 *  是合法边界（中文无词间空格——用 \w 而非 \p{L}，否则「请ultrathink」被拒）。 */
function wordBoundaryRegex(word: string): RegExp {
  const left = '(?<![\\w./\\\\-])(?<!::)'
  const right = '(?![\\w/\\\\-])(?!\\.[\\w-])(?!\\()'
  return new RegExp(`${left}${word}${right}`, 'u')
}

/** 文本 prose 中是否含独立关键词（代码区/HTML 内不触发）。 */
export function containsKeyword(text: string, word: string): boolean {
  const re = wordBoundaryRegex(word)
  if (!re.test(text)) return false
  return re.test(stripHtml(stripMarkdownCode(text)))
}

// ── notice 构建 ────────────────────────────────────────────

export type MagicKeywordNotice = { id: string; content: string }

/**
 * 检测用户消息中的 magic keywords 并构建 notice 列表（可直接逐条 injectSteering）。
 * 合成 prompt（子 agent/工作流）不应调用本函数。
 *
 * @param opts.tools   本轮启用的工具名（requires 门控）
 * @param opts.config  config.magicKeywords（缺省视为全开）
 * @param opts.workflowList 可用工作流（workflowz 的 notice 用）
 */
export function buildMagicKeywordNotices(
  text: string,
  opts: {
    tools: readonly string[]
    config?: Partial<Config['magicKeywords']>
    workflowList?: ReadonlyArray<{ name: string; description: string }>
  },
): MagicKeywordNotice[] {
  const cfg = opts.config
  if (cfg?.enabled === false) return []
  const notices: MagicKeywordNotice[] = []
  let ctx: MagicKeywordContext | undefined
  for (const kw of MAGIC_KEYWORDS) {
    if (cfg?.[kw.id] === false) continue
    if (!containsKeyword(text, kw.word)) continue
    ctx ??= { tools: opts.tools, workflowList: opts.workflowList ?? [] }
    if (!kw.requires.every((t) => ctx?.tools.includes(t))) continue
    notices.push({ id: kw.id, content: kw.notice(ctx) })
  }
  return notices
}
