// grep / glob 匹配结果的旁白：命中数被截断、以及「一个都没匹配到」。
//
// executor 把 count/truncated 放在 metadata 里（grep 命中数达到 maxResults 时
// truncated=true，而 output 文本里没有任何标记；见 src/tools/builtin/grep.ts），
// 两个视图此前只读 output 文本，于是两种结果都被说成了「就这些」：
//   - 满 200 条：用户据此告诉同事「全仓库就这 200 处」，实际还有更多；
//   - 0 命中：output 为空串，渲染处的 `{text && …}` 让整块变成空白 div，
//     与「输出丢了 / 工具没跑」在界面上完全同形。
// 口径与 toolError.tsx 相同：拿不到的事实不能靠猜，宁可少说也不能说错。

import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'

const note = css`
  font-size: 12px;
  color: var(--haze-color-text-secondary);
  margin-bottom: 4px;
`

type MatchMeta = { count?: number; truncated?: boolean } | undefined

/** 从 success 结果的 metadata 里取匹配计数；其它形态（truncated/error/无结果）一律 undefined。 */
export function matchMeta(output?: ToolResult): MatchMeta {
  if (output?._tag !== 'success') return undefined
  return output.metadata as MatchMeta
}

/**
 * 渲染匹配结果的一句旁白；不需要旁白时返回 null。
 *
 * `noun` 是「匹配」这个词的宾语，两视图共用同一口径，仅措辞不同。
 */
export function MatchSummary({ output, noun }: { output?: ToolResult; noun: string }) {
  const meta = matchMeta(output)
  if (meta === undefined) return null
  const count = typeof meta.count === 'number' ? meta.count : undefined
  if (meta.truncated === true) {
    return (
      <div className={note} data-testid="tool-match-truncated">
        {`已截断：仅显示前 ${count ?? ''} 条${noun}，其余未随结果返回`}
      </div>
    )
  }
  if (count === 0) {
    return (
      <div className={note} data-testid="tool-match-empty">
        没有匹配
      </div>
    )
  }
  return null
}
