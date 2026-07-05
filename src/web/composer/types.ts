/** Composer Prompt 数据结构（移植自 opencode，React 版）。 */

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

/** 图片附件不进 contenteditable DOM（无法在文本流表示），单独维护。 */
interface ImagePart {
  type: 'image'
  mediaType: string
  /** base64 dataURL（不含 data: 前缀）。 */
  data: string
}

type ContentPart = TextPart | FilePart | SnippetPart | ImagePart
type Prompt = ContentPart[]

const DEFAULT_PROMPT: Prompt = [{ type: 'text', content: '', start: 0, end: 0 }]

/** 计算纯文本流总长度（file/snippet 的可见标签计入，image 不计）。 */
function promptLength(prompt: Prompt): number {
  return prompt.reduce((len, part) => {
    if (part.type === 'text' || part.type === 'file') return len + part.content.length
    if (part.type === 'snippet') return len + part.label.length
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
      return ''
    })
    .join('')
}

/** 判断 Prompt 是否为空（无任何非空文本且无 file/image）。 */
function isPromptEmpty(prompt: Prompt): boolean {
  return promptLength(prompt) === 0 && !prompt.some((p) => p.type === 'file')
}

export type { ContentPart, FilePart, ImagePart, PartBase, Prompt, SnippetPart, TextPart }
export {
  DEFAULT_PROMPT,
  isPromptEmpty,
  promptLength,
  promptToMessageText,
  promptToText,
  snippetLabel,
}
