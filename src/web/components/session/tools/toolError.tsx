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
  /* 必须限高：失败恰恰是最长的那批文本。executor 只对 _tag:'success' 做
     truncateOutput，error 原样透传；bash 又把整段 stdout+stderr（每路 256KB）
     塞进 error 字符串——一次失败的构建/测试就是几十万字符的红色块。此前这里
     没有上限，而同一条消息的成功输出是 400px + 滚动（见 BashToolView 的 out）：
     实测同一份 300000 字符 payload，成功块渲染 400px，失败块渲染 48002px，
     在 768px 视口里把整条时间线顶出去且无处可滚。 */
  max-height: 400px;
  overflow: auto;
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

const INLINE_ERROR_LINE = /^Errors?:\s*/

/**
 * 工具把操作级失败写进 success 结果的 output 文本时的统一口径。
 *
 * todo / kanban 执行器刻意让「用户输入有误」这类操作失败仍返回 success
 * （不污染工具指标、让模型读得见原因好重试），失败原因以 `Errors: …` 行随
 * output 一起返回。两个视图此前只读 metadata、从不渲染 output 文本，于是这次
 * 失败被渲染成一个 ✓ 完成的折叠行：todo 侧整批改动被丢弃、看板侧卡片原地未动，
 * 用户看到的却与一次成功执行完全同形。
 *
 * 返回 null 表示「没有内嵌失败原因」，供调用方与正常渲染并存。
 */
export function toolInlineErrorText(output: ToolResult | undefined): string | null {
  if (output?._tag !== 'success' || typeof output.output !== 'string') return null
  const text = output.output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => INLINE_ERROR_LINE.test(line))
    .map((line) => line.replace(INLINE_ERROR_LINE, '').trim())
    .filter(Boolean)
    .join('\n')
  return text || null
}

/** 渲染 success 结果里内嵌的失败原因行；无内嵌原因返回 null。 */
export function ToolInlineError({ output }: { output?: ToolResult }) {
  const text = toolInlineErrorText(output)
  if (text === null) return null
  return (
    <div className={err} data-testid="tool-inline-error">
      {text}
    </div>
  )
}
