/** 折叠态摘要的最大长度，超出以 … 截断。 */
const MAX = 60

function clip(s: string): string {
  const one = s.split('\n')[0]?.trim() ?? ''
  return one.length > MAX ? `${one.slice(0, MAX)}…` : one
}

/**
 * 生成工具调用折叠态的摘要文本（不含工具名前缀）。
 * 按工具类型提取最关键的一个参数，未命中则取首个标量值。
 */
export function toolSummary(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  switch (tool) {
    case 'read':
    case 'write':
    case 'edit':
      return typeof i.path === 'string' ? i.path : ''
    case 'bash':
      return typeof i.command === 'string' ? `$ ${clip(i.command)}` : ''
    case 'grep':
      return typeof i.pattern === 'string' ? `"${i.pattern}"` : ''
    case 'glob':
      return typeof i.pattern === 'string' ? i.pattern : ''
    default: {
      // 取首个字符串标量值作为兜底摘要
      const first = Object.values(i).find((v) => typeof v === 'string')
      return first ? clip(first as string) : ''
    }
  }
}
