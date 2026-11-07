import { headChars } from '@shared/utils/string.js'
import { str } from '@/components/session/utils/shapes.js'

/** 折叠态摘要的最大长度，超出以 … 截断。 */
const MAX = 60

function clip(s: string): string {
  const one = s.split('\n')[0]?.trim() ?? ''
  // headChars 内收切点：截断不落在 emoji 代理对中间产出孤立码元（渲染为 U+FFFD）。
  return one.length > MAX ? `${headChars(one, MAX)}…` : one
}

/**
 * 生成工具调用折叠态的摘要文本（不含工具名前缀）。
 * 按工具类型提取最关键的一个参数，未命中则取首个标量值。
 * 字段读取统一走 str()（toolShape.tsx 的同一实现）：类型错即读不出来，回落空串。
 */
export function toolSummary(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  switch (tool) {
    case 'read':
    case 'write':
    case 'edit':
      return str(i.path) ?? ''
    case 'bash': {
      const command = str(i.command)
      return command === undefined ? '' : `$ ${clip(command)}`
    }
    case 'grep': {
      const pattern = str(i.pattern)
      return pattern === undefined ? '' : `"${pattern}"`
    }
    case 'glob':
      return str(i.pattern) ?? ''
    case 'task': {
      // 批量模式显示任务数，单任务模式显示 description/prompt 摘要
      if (Array.isArray(i.tasks) && i.tasks.length > 0) {
        const type = str(i.subagent_type) ?? 'general'
        return `${type} × ${i.tasks.length} agents`
      }
      const type = str(i.subagent_type) ?? ''
      const prompt = str(i.prompt)
      const desc = str(i.description) ?? (prompt === undefined ? '' : clip(prompt))
      return [type, desc].filter(Boolean).join(' · ')
    }
    case 'todo': {
      const op = str(i.op) ?? 'view'
      const task = str(i.task)
      const phase = str(i.phase)
      const target = [phase, task === undefined ? '' : clip(task)].filter(Boolean).join(' · ')
      return target || op
    }
    default: {
      // 取首个字符串标量值作为兜底摘要
      const first = Object.values(i)
        .map((v) => str(v))
        .find((v) => v !== undefined)
      return first === undefined ? '' : clip(first)
    }
  }
}
