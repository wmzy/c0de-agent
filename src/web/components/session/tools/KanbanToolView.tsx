import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { ToolError, ToolInlineError } from '@/components/session/tools/toolError.js'
import { ShapeNotice, str, wellFormedBoard } from '@/components/session/tools/toolShape.js'
import { ToolTruncated } from '@/components/session/tools/toolTruncated.js'

type KanbanCard = {
  id: string
  title: string
  columnId: string
  priority: 'high' | 'medium' | 'low'
  description: string | null
}

type KanbanColumn = { id: string; name: string }

type KanbanBoard = {
  columns: KanbanColumn[]
  cards: KanbanCard[]
}

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

const opLabel = css`
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  color: var(--haze-color-primary);
  background: color-mix(in srgb, var(--haze-color-primary) 10%, transparent);
  padding: 1px 6px;
  border-radius: 3px;
  margin-bottom: 6px;
`

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

const empty = css`
  color: var(--haze-color-text-secondary);
  font-size: 13px;
  font-style: italic;
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
function BoardView({ board, unreadable = false }: { board: KanbanBoard; unreadable?: boolean }) {
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
  // 与 todo 同口径：op 直接当 React child 渲染，id 直接 `.slice()`——两者都是
  // 原样落库的未受信 JSON，对象形状会在渲染期抛错并把整个应用壳换成「页面渲染出错」。
  const op = str(i.op) ?? 'view'

  // 失败优先于「无看板」：move/add 失败时 metadata 里没有 board，此前整块渲染塌成
  // 一行 op 名，用户既看不到失败原因，也看不出自己那张卡到底有没有移动成功。
  if (output?._tag === 'error' || status === 'error') {
    return (
      <div>
        <span className={opLabel}>kanban/{op}</span>
        <ToolError output={output} status={status} />
      </div>
    )
  }

  // 「输出被截断」不是「没有看板」：超上限的结果以 _tag:'truncated' 返回且没有
  // metadata，board 只能为 null，整块塌成一行 `kanban/view`——用户看不出看板还有
  // 几千张卡（executor 只在 success 分支返回 metadata，见 src/tools/executor.ts）。
  if (output?._tag === 'truncated') {
    return (
      <div>
        <span className={opLabel}>kanban/{op}</span>
        <ToolTruncated output={output} />
      </div>
    )
  }

  // 「结果还没回来」不是「没有看板」：running 态（tool_result 尚未到达）此前整块
  // 只剩一行 `kanban/view` op 名——折叠头是「⏳ 执行中」，展开正文却什么都没有。
  // 与 TodoToolView 的 output === undefined 分支同口径（f07795b 给 todo 补的执行中
  // 说明）：没有结果就说还在执行，绝不把「还没拿到」讲成一个关于内容的结论。
  if (output === undefined) {
    return (
      <div>
        <span className={opLabel}>kanban/{op}</span>
        <div className={empty} data-testid="kanban-running">
          执行中…看板内容随执行结果返回
        </div>
      </div>
    )
  }

  // Extract board from output metadata
  //
  // 与 todo 同理：metadata 原样落库、未受信，此前 `as KanbanBoard` 之后直接
  // `board.cards.length` / `board.columns.map`，一条 `{cards:[{title:{a:1}}]}` 就在
  // 渲染期抛错 → 整个应用被 ErrorBoundary 换成「页面渲染出错」。渲染前收敛，
  // 被丢弃的条目明确计数。
  let board: KanbanBoard | null = null
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

  // Show op detail for add/move/delete
  const title = str(i.title)
  const columnId = str(i.columnId)
  const cardId = str(i.id)
  let detailText = ''
  if (op === 'add' && title) detailText = `新建: ${title}`
  else if (op === 'move' && columnId) detailText = `移动到: ${columnId}`
  else if (op === 'delete' && cardId) detailText = `删除: ${cardId.slice(0, 8)}`

  return (
    <div>
      <span className={opLabel}>kanban/{op}</span>
      <ToolInlineError output={output} tool="kanban" />
      {detailText && <div className={detail}>{detailText}</div>}
      {board && <BoardView board={board} unreadable={dropped > 0 || malformed} />}
      {board && (dropped > 0 || malformed) && <ShapeNotice dropped={dropped} />}
    </div>
  )
}
