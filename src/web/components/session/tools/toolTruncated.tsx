// 「输出超过上限被截断」（ToolResult._tag === 'truncated'）的统一渲染。
//
// executor 对超过上限的成功结果（maxLines 2000 / maxChars 100000，见
// src/tools/truncate.ts）返回 truncated，并**丢掉 metadata**。只渲染 output 文本的
// 视图（read/bash/grep/glob/fallback/task）不受影响——它们本来就把 truncated 当成功
// 取文本；而 todo / kanban 视图是照 metadata 画结构的（阶段、列、卡片），只在
// success 分支读它。于是「输出太大、结构没随结果返回」被渲染成空态：待办显示
// "Todo list is empty."、看板整块塌成一行 `kanban/view`。用户会以为任务/卡片被删了，
// 而真实情况是这次调用成功、内容只是没随结果返回。
//
// 这里统一退回渲染文本结果 + 说明截断，至少让用户看到「有内容，但没随结果返回」，
// 而不是一个与事实相反的「空」。

import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'

const notice = css`
  font-size: 12px;
  line-height: 1.5;
  color: var(--haze-color-text-secondary);
  margin-bottom: 4px;
`

const pre = css`
  margin: 0;
  padding: 8px;
  background: var(--haze-color-bg-muted);
  border-radius: 6px;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 400px;
`

/** 渲染被截断的工具结果文本；非截断结果返回 null。 */
export function ToolTruncated({ output }: { output?: ToolResult }) {
  if (output?._tag !== 'truncated') return null
  return (
    <div data-testid="tool-truncated">
      <div className={notice}>
        {`输出超过上限已截断${output.totalLines > 0 ? `（共 ${output.totalLines} 行）` : ''}——完整内容未随结果返回，下方为截断后的文本。`}
      </div>
      <pre data-testid="tool-truncated-text" className={pre}>
        {output.output}
      </pre>
    </div>
  )
}
