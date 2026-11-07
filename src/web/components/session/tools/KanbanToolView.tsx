import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { empty, OpToolShell } from '@/components/session/tools/OpToolShell.js'
import { ToolInlineError } from '@/components/session/tools/toolError.js'
import {
  type BoardLike,
  ShapeNotice,
  str,
  wellFormedBoard,
} from '@/components/session/tools/toolShape.js'

type KanbanInput = {
  op?: string
  title?: string
  id?: string
  columnId?: string
  priority?: string
}

const PRIORITY_DOT: Record<string, string> = {
  high: '🔴',
  medium: '🟡',
  low: '⚪',
}

const boardStyle = css`
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const colHeader = css`
  font-size: 11px;
  font-weight: 600;
  color: var(--haze-color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-top: 4px;
`

const cardRow = css`
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 1px 0;
  font-size: 12px;
  line-height: 1.4;
`

const detail = css`
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  margin-bottom: 4px;
`

/** Render the kanban board (columns with cards).
 *
 *  unreadable：形状有丢弃且一条卡片都没剩下——「看板为空」是谎报（真实情况是读不
 *  出来），空态让位给 ShapeNotice。 */
function BoardView({ board, unreadable = false }: { board: BoardLike; unreadable?: boolean }) {
  if (board.cards.length === 0) {
    return unreadable ? null : <div className={empty}>看板为空</div>
  }
  // 卡片引用的列已不存在（历史脏数据：列被删/改名后残留）时，只按现有列过滤会让
  // 这些卡片一条都不画：全是幽灵卡时整个看板渲染成一块空白 div（连列头都没有），
  // 用户会认定卡片被谁删了。执行器早已为此在 output 文本里补「## 未归属列 (N)」
  // 段落（src/tools/builtin/kanban.ts），视图必须说同一件事——模型看得见、人看不见
  // 是最坏的一种「看板为空」。
  const colIds = new Set(board.columns.map((c) => c.id))
  const orphans = board.cards.filter((c) => !colIds.has(c.columnId))
  return (
    <div className={boardStyle}>
      {board.columns.map((col) => {
        const cards = board.cards.filter((c) => c.columnId === col.id)
        if (cards.length === 0) return null
        return (
          <div key={col.id}>
            <div className={colHeader}>
              {col.name} ({cards.length})
            </div>
            {cards.map((card) => (
              <div key={card.id} className={cardRow}>
                <span>{PRIORITY_DOT[card.priority] ?? '⚪'}</span>
                <span>{card.title}</span>
              </div>
            ))}
          </div>
        )
      })}
      {orphans.length > 0 && (
        <div>
          <div className={colHeader}>未归属列 ({orphans.length})</div>
          <div className={detail}>引用了已不存在的列，移动或删除前不显示在列内</div>
          {orphans.map((card) => (
            <div key={card.id} className={cardRow}>
              <span>{PRIORITY_DOT[card.priority] ?? '⚪'}</span>
              <span>{card.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function KanbanToolView({
  input,
  output,
  status,
}: {
  input: unknown
  output?: ToolResult
  status: string
}) {
  const i = (input ?? {}) as KanbanInput
  return (
    <OpToolShell
      tool="kanban"
      input={input}
      output={output}
      status={status}
      opPrefix="kanban/"
      runningText="执行中…看板内容随执行结果返回"
    >
      {(op) => {
        // Extract board from output metadata
        //
        // metadata 原样落库、未受信，此前 `as KanbanBoard` 之后直接
        // `board.cards.length` / `board.columns.map`，一条 `{cards:[{title:{a:1}}]}` 就在
        // 渲染期抛错 → 整个应用被 ErrorBoundary 换成「页面渲染出错」。渲染前收敛，
        // 被丢弃的条目明确计数。
        let board: BoardLike | null = null
        let dropped = 0
        let malformed = false
        if (output?._tag === 'success') {
          const meta = output.metadata as { board?: unknown } | undefined
          // 压根没有 board（add/move 的成功结果）不是「看板为空」——保持 null 不画。
          if (meta?.board !== undefined && meta?.board !== null) {
            const parsed = wellFormedBoard(meta.board)
            board = parsed.value
            dropped = parsed.dropped
            malformed = parsed.malformed
          }
        }

        // Show op detail for add/move/delete（title/columnId/id 与 op 一样是原样落库的
        // 未受信 JSON：id 只有真字符串才 `.slice()`，对象形状会在渲染期抛错）
        const title = str(i.title)
        const columnId = str(i.columnId)
        const cardId = str(i.id)
        let detailText = ''
        if (op === 'add' && title) detailText = `新建: ${title}`
        else if (op === 'move' && columnId) detailText = `移动到: ${columnId}`
        else if (op === 'delete' && cardId) detailText = `删除: ${cardId.slice(0, 8)}`

        return (
          <>
            <ToolInlineError output={output} tool="kanban" />
            {detailText && <div className={detail}>{detailText}</div>}
            {board && <BoardView board={board} unreadable={dropped > 0 || malformed} />}
            {board && (dropped > 0 || malformed) && <ShapeNotice dropped={dropped} />}
          </>
        )
      }}
    </OpToolShell>
  )
}
