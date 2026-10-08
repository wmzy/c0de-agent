// 工具失败结果（ToolResult._tag === 'error'）的统一渲染与样式。
//
// 抽出前 Read/Write/Edit 三个视图各自持有一份逐字节相同的 `err` css 模板，
// Todo/Kanban 则完全没有失败分支——失败时落进「空」渲染（"Todo list is empty."），
// 把真实原因吞掉。共用一份样式后新增视图不再有漏抄的动机。

import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'

const err = css`
  font-size: 13px;
  color: var(--haze-color-danger);
  background: var(--haze-color-danger-subtle);
  padding: 6px 8px;
  border-radius: 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`

const NO_DETAIL = '工具执行失败，但没有返回错误信息。'

/**
 * 从工具结果里取出失败原因；成功/未完成返回 null。
 *
 * 终态与 output 同源（normalizeParts.resultStatus 依据同一个 _tag 推导），
 * 但仍保留 status 作为兜底判定：status='error' 而 output 缺失/结构异常时，
 * 旧实现两条件同时要求会直接掉进正常渲染，用户看到的是「什么都没发生」。
 */
export function toolErrorText(output: ToolResult | undefined, status?: string): string | null {
  if (output?._tag === 'error') {
    const text = output.error?.trim()
    return text || NO_DETAIL
  }
  return status === 'error' ? NO_DETAIL : null
}

/** 渲染工具失败原因；非失败结果返回 null，供调用方直接短路。 */
export function ToolError({ output, status }: { output?: ToolResult; status?: string }) {
  const text = toolErrorText(output, status)
  if (text === null) return null
  return (
    <div className={err} data-testid="tool-error">
      {text}
    </div>
  )
}
