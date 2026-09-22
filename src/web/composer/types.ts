/** Composer Prompt 数据结构（移植自 opencode，React 版）。 */

import { stripMarkdownCode } from '@shared/utils/markdown-code.js'

interface PartBase {
  /** 该 part 在纯文本流中的起始字符偏移（BR 算 1 字符 \n）。 */
  start: number
  /** 该 part 在纯文本流中的结束字符偏移。 */
  end: number
}

interface TextPart extends PartBase {
  type: 'text'
  content: string
}

interface FilePart extends PartBase {
  type: 'file'
  /** 相对 cwd 的文件路径。 */
  path: string
  /** 文件内容（@ 选择时读入，发送时注入上下文快照）。 */
  content: string
}

/** 选区引用 pill：编辑器内只显示位置标签（如 `📄 a.ts:5-10`），
 * hover 展示 snippet，点击在右侧定位，提交时把 snippet 注入消息以省一次 read 调用。 */
interface SnippetPart extends PartBase {
  type: 'snippet'
  /** 相对 cwd 的文件路径。 */
  path: string
  /** 选区起始行（1-indexed）。 */
  lineStart: number
  /** 选区结束行（1-indexed）。 */
  lineEnd: number
  /** pill 显示的标签（= textContent，参与光标定位长度计算）。 */
  label: string
  /** 选中的实际代码，提交时注入消息（编辑器不显示，hover 时展示）。 */
  snippet: string
}

/** 终端内容引用 pill：显示标签（如 `🖥 命令: npm test`），
 * 提交时展开为 ```terminal 代码块注入 LLM 上下文。 */
interface TerminalPart extends PartBase {
  type: 'terminal'
  /** pill 显示的标签（= textContent，参与光标定位长度计算）。 */
  label: string
  /** 实际终端文本（选区文本 或 命令+输出），提交时展开为代码块。 */
  content: string
}

/** 图片附件不进 contenteditable DOM（无法在文本流表示），单独维护。 */
interface ImagePart {
  type: 'image'
  mediaType: string
  /** base64 dataURL（不含 data: 前缀）。 */
  data: string
}

type ContentPart = TextPart | FilePart | SnippetPart | TerminalPart | ImagePart
type Prompt = ContentPart[]

/** 发送载荷（composer 层产出）：prompt 结构随行——@agent 提及提取需要区分
 *  用户输入文本与 snippet/terminal 展开内容。agents 由 Composer 层按提及
 *  提取结果补齐（见 Composer 的 SendPayload）。 */
type ComposerSendPayload = {
  text: string
  files: string[]
  images: ImagePart[]
  prompt: Prompt
}

const DEFAULT_PROMPT: Prompt = [{ type: 'text', content: '', start: 0, end: 0 }]

/** 计算纯文本流总长度（file/snippet 的可见标签计入，image 不计）。 */
function promptLength(prompt: Prompt): number {
  return prompt.reduce((len, part) => {
    if (part.type === 'text' || part.type === 'file') return len + part.content.length
    if (part.type === 'snippet') return len + part.label.length
    if (part.type === 'terminal') return len + part.label.length
    return len
  }, 0)
}

/** 将 Prompt 的文本流（text + file 标签 + snippet 标签）join 成纯字符串。
 * 用于光标定位、popover 检测、历史草稿——snippet 此处仅贡献标签长度。 */
function promptToText(prompt: Prompt): string {
  return prompt
    .map((p) => {
      if (p.type === 'text' || p.type === 'file') return p.content
      if (p.type === 'snippet') return p.label
      if (p.type === 'terminal') return p.label
      return ''
    })
    .join('')
}

/** 构造 snippet pill 标签：`📄 path:5` 或 `📄 path:5-10`。 */
function snippetLabel(path: string, lineStart: number, lineEnd: number): string {
  const loc = lineStart === lineEnd ? `${lineStart}` : `${lineStart}-${lineEnd}`
  return `📄 ${path}:${loc}`
}

/** 将 Prompt 展开为提交给后端的消息文本：snippet pill 展开为带行号标注的代码块，
 * 让 LLM 直接获得选区内容而无需发起 read 调用。 */
function promptToMessageText(prompt: Prompt): string {
  return prompt
    .map((p) => {
      if (p.type === 'text' || p.type === 'file') return p.content
      if (p.type === 'snippet') {
        const loc = p.lineStart === p.lineEnd ? `${p.lineStart}` : `${p.lineStart}-${p.lineEnd}`
        return `📄 \`${p.path}:${loc}\`:\n\`\`\`\n${p.snippet}\n\`\`\``
      }
      if (p.type === 'terminal') {
        return `\`\`\`terminal\n${p.content}\n\`\`\``
      }
      return ''
    })
    .join('')
}

/** 判断 Prompt 是否为空（无任何非空白文本且无 file/snippet/terminal）。
 * 纯空白文本（如删空后残留的 <br> 解析出的 "\n"）视为空，
 * 保证发送按钮禁用态与 send() 的空值守卫判定一致。 */
function isPromptEmpty(prompt: Prompt): boolean {
  return !prompt.some(
    (p) =>
      (p.type === 'text' && p.content.trim().length > 0) ||
      p.type === 'file' ||
      p.type === 'snippet' ||
      p.type === 'terminal',
  )
}

/** 单个 part 在 promptToText 平铺文本中贡献的长度（image 不计入）。 */
function partFlatLength(part: ContentPart): number {
  if (part.type === 'text' || part.type === 'file') return part.content.length
  if (part.type === 'snippet' || part.type === 'terminal') return part.label.length
  return 0
}

/** 定位光标前的 @token（'@' + 非空白字符）在平铺文本中的范围。
 *  光标偏移与 promptToText 同坐标系（editor-dom 的 getCursorPosition 口径）。
 *  无 token 返回 null。 */
function atTokenRange(text: string, cursor: number): { start: number; end: number } | null {
  const m = text.slice(0, cursor).match(/@(\S*)$/)
  if (!m) return null
  return { start: cursor - m[0].length, end: cursor }
}

/**
 * 用 replacement 替换平铺文本 [start, end) 范围，保留范围外的全部既有 part。
 * popover 插入（@文件/@agent）此前从 promptToText 平铺文本重建整个 prompt——
 * 既有 file/snippet/terminal pill 被降级为纯文本：发送时 files 附件丢失、
 * snippet/terminal 内容不再注入消息。范围落在 text part 内时切分该 part；
 * 与 pill 重叠时保守保留 pill（不拆分，实践上 token 只出现在 text 中）。
 */
function replacePromptRange(
  prompt: Prompt,
  start: number,
  end: number,
  replacement: Prompt,
): Prompt {
  const out: ContentPart[] = []
  let offset = 0
  let inserted = false
  const insertNow = () => {
    if (!inserted) {
      out.push(...replacement)
      inserted = true
    }
  }
  const pushText = (content: string) => {
    if (content.length > 0) out.push({ type: 'text', content, start: 0, end: content.length })
  }
  for (const part of prompt) {
    const len = partFlatLength(part)
    const partStart = offset
    const partEnd = offset + len
    offset = partEnd
    // 范围完全落在该 text part 内（含空范围的边界点）→ 在此定位插入。
    if (part.type === 'text' && partStart <= start && end <= partEnd) {
      const s = start - partStart
      const e = end - partStart
      pushText(part.content.slice(0, s))
      insertNow()
      pushText(part.content.slice(e))
      continue
    }
    if (partStart >= end || partEnd <= start) {
      // 空范围插入点（无任何 part 包含该点，落在 part 间隙）→ 插入其后邻 part 之前。
      if (start === end && !inserted && partStart >= start) insertNow()
      out.push(part)
      continue
    }
    // 与范围重叠但非包含（跨 part 或落在 pill 上）：文本切掉重叠段，pill 保守保留。
    if (part.type === 'text') {
      const s = Math.max(0, start - partStart)
      const e = Math.min(part.content.length, end - partStart)
      pushText(part.content.slice(0, s))
      insertNow()
      pushText(part.content.slice(e))
      continue
    }
    out.push(part)
  }
  insertNow() // 范围在所有 part 之后：追加
  return out
}

/** 保留全部 text/file/snippet/terminal part 的深拷贝（image 走独立附件通道）。
 *  append* 引用操作此前逐类挑选复制（file 版丢 snippet/terminal、snippet 版
 *  丢 terminal），追加一个引用会静默吞掉其他类型的引用。 */
function clonePromptParts(prompt: Prompt): Prompt {
  return prompt.filter((p) => p.type !== 'image').map((p) => ({ ...p }) as ContentPart)
}

/** 从 Prompt 提取 @agent 提及（仅保留真实可调用的 subagent 名，去重保序）。
 *
 * 只扫描用户输入的 **text part**：snippet/terminal pill 展开的是被引用的
 * 代码/终端输出（promptToMessageText 会包成代码块），file part 是路径——
 * 它们里面的 `@name` 不构成「用户点名派发」的意图。文本 part 内再剥离
 * markdown 代码块/行内代码（prose 感知，与 workflowz 关键词、<todo:*> 标签
 * 检测共用 shared/utils/markdown-code.ts）——用户手写的 ``` 示例里的 @name
 * 同样不得触发。此前对平铺消息文本整体正则：引用片段/示例代码里的 agent 名
 * 被当成提及，服务端据此注入「用户要求派发 subagent」指令，运行被误导去
 * 派发子 agent（隔离 worktree + 独立 session + 额外成本）。 */
function extractAgentMentions(prompt: Prompt, subagentNames: readonly string[]): string[] {
  const names = new Set(subagentNames)
  const out: string[] = []
  for (const part of prompt) {
    if (part.type !== 'text') continue
    for (const m of stripMarkdownCode(part.content).matchAll(/@([\w-]+)/g)) {
      const name = m[1] ?? ''
      if (names.has(name) && !out.includes(name)) out.push(name)
    }
  }
  return out
}

export type {
  ComposerSendPayload,
  ContentPart,
  FilePart,
  ImagePart,
  PartBase,
  Prompt,
  SnippetPart,
  TerminalPart,
  TextPart,
}
export {
  atTokenRange,
  clonePromptParts,
  DEFAULT_PROMPT,
  extractAgentMentions,
  isPromptEmpty,
  promptLength,
  promptToMessageText,
  promptToText,
  replacePromptRange,
  snippetLabel,
}
