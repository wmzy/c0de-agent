// 工具 execute 的统一结果构造与骨架（dap / lsp 工具共用）。
import type { ToolResult } from '../../shared/types/tool.js'
import { errorMessage } from '../../shared/utils/string.js'

function ok(output: unknown): ToolResult {
  return {
    _tag: 'success',
    output: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
  }
}

function fail(message: string): ToolResult {
  return { _tag: 'error', error: message }
}

/** execute 统一骨架：fn 成功 → ok(结果)；异常 → fail(`<label> failed: <msg>`)。 */
const run = async (label: string, fn: () => Promise<unknown>): Promise<ToolResult> => {
  try {
    return ok(await fn())
  } catch (error) {
    return fail(`${label} failed: ${errorMessage(error)}`)
  }
}

export { fail, ok, run }
