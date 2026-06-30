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

/** 图片附件不进 contenteditable DOM（无法在文本流表示），单独维护。 */
interface ImagePart {
  type: 'image'
  mediaType: string
  /** base64 dataURL（不含 data: 前缀）。 */
  data: string
}

type ContentPart = TextPart | FilePart | ImagePart
type Prompt = ContentPart[]

const DEFAULT_PROMPT: Prompt = [{ type: 'text', content: '', start: 0, end: 0 }]

/** 计算纯文本流总长度（含 file part 的 content 长度，不含 image）。 */
function promptLength(prompt: Prompt): number {
  return prompt.reduce((len, part) => len + ('content' in part ? part.content.length : 0), 0)
}

/** 将 Prompt 的文本流（text + file content）join 成纯字符串。 */
function promptToText(prompt: Prompt): string {
  return prompt
    .map((p) => ('content' in p ? p.content : ''))
    .join('')
}

/** 判断 Prompt 是否为空（无任何非空文本且无 file/image）。 */
function isPromptEmpty(prompt: Prompt): boolean {
  return promptLength(prompt) === 0 && !prompt.some((p) => p.type === 'file')
}

export type { ContentPart, FilePart, ImagePart, PartBase, Prompt, TextPart }
export { DEFAULT_PROMPT, isPromptEmpty, promptLength, promptToText }
