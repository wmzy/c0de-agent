// 工具视图/摘要读取「原样落库的未受信 JSON」时的最小形状判别原语。
//
// tool_result.metadata 与 tool_call.input 都是持久层原样保存的 JSON（只过滤
// _parseError/_raw，导入层不递归校验，完整口径见 toolShape.tsx）：模型把字段
// 写成对象/数组时，`x.slice()` 与把对象当 React child 渲染都会在渲染期抛错。
// 判别原语由 toolShape.tsx（视图侧收敛）与 toolSummary.ts（折叠摘要）共享，
// 单一实现，不再各持一份 typeof 内联。

/** 非数组的普通对象（数组/null/原始值都排除）。 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 只认真字符串：参与渲染的字段类型错就是读不出来。 */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
