// 工具视图读取外部形状的统一收敛口径。
//
// 缺陷：tool_result.metadata 与 tool_call.input 都是**原样落库**的 JSON——
// 持久层只过滤 _parseError/_raw（src/core/loop/persist.ts），导入层只校验分片
// 外形、不递归 metadata（src/session/import.ts:59）。于是模型把一个字段写成对象、
// 或历史/手写导入里留着畸形条目时，`phase.tasks.filter is not a function`、
// `inp.prompt.slice is not a function` 或 React 的
// `Objects are not valid as a React child` 会在**渲染期**抛错；而
// ErrorBoundary 裹的是整个应用壳（src/web/App.tsx），一次这样的抛错＝顶栏、
// 侧栏、会话页一起被换成「页面渲染出错」，用户既读不到历史也发不了消息，
// 每次展开那条工具块都重演一遍。
//
// 服务端早就为此在 todo/kanban 执行器里加了 sanitize（畸形条目曾击穿 500），
// 视图侧没有对应的一道钳制：同一个脏数据在面板侧被挡住，在时间线侧没人挡。
// 口径照抄服务端 + toolError.tsx 的「拿不到的事实宁少勿坏」：**渲染前收敛，宁少勿坏；
// 丢掉的条目必须说出来，绝不把「读不出来」渲染成「空」。**

import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'

const notice = css`
  margin-top: 4px;
  font-size: 12px;
  color: var(--haze-color-warning);
`

/** 有条目被丢弃（或整体形状读不出来）时的可见声明。 */
export function ShapeNotice({ dropped }: { dropped: number }) {
  return (
    <div className={notice} data-testid="tool-shape-notice">
      {dropped > 0
        ? `有 ${dropped} 项内容格式异常，已跳过（原始结果见下方输出）`
        : '结果格式异常，无法解析（原始结果见下方输出）'}
    </div>
  )
}

/** 非数组的普通对象（数组/null/原始值都排除）。 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 只认真字符串：参与渲染的字段类型错就是读不出来（与 toolSummary.ts 同口径）。 */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * 工具**入参**里某个字段的收敛（入参与结果一样是原样落库的未受信 JSON）。
 *
 * `broken` = 「这里本来应该有值，但读不出来」：模型把 `bash` 的 command、`write`
 * 的 path/content 写成对象或数组，或整个 input 根本不是对象（历史导入里
 * input 是一段字符串）。这些值此前被 `input?.command ?? ''` 一路带到需要字符串的
 * 渲染点——`extToLang(path)` 里的 `filename.split('.')` 抛 TypeError、
 * `<pre>`/CodeBlock 收到对象抛 `Objects are not valid as a React child`，都在
 * **渲染期**发生，而 ErrorBoundary 裹的是整个应用壳：顶栏、侧栏、会话页一起被
 * 换成「页面渲染出错」，这条会话在刷新前完全打不开、也发不出消息。
 *
 * 调用方不得用 `value ?? ''` 把 broken 当成「没有内容」：空命令/空文件正文与
 * 「读不出来」是两件事，前者会让用户以为工具跑了个空操作。broken 时应退回
 * FallbackToolView（把原始入参摊平成 [path, value] 显示）。
 */
export function strArg(input: unknown, key: string): { value?: string; broken: boolean } {
  if (!isRecord(input)) return { broken: input !== undefined && input !== null }
  const v = input[key]
  if (v === undefined || v === null) return { broken: false }
  const value = str(v)
  return value === undefined ? { broken: true } : { value, broken: false }
}

/** 收敛结果：可用条目 + 被丢弃的条目数 + 整体形状是否根本不是预期的容器。 */
export type Sanitized<T> = { value: T; dropped: number; malformed: boolean }

/** 结果整体读不出来时的替代文案：说「读不出来」，不说「失败」，更不说「空」。 */
export const UNREADABLE_RESULT_TEXT = '工具结果格式无法识别（可能是历史数据损坏），无法显示详情。'

/**
 * 工具结果本身（不只是它的 metadata）的收敛：整份 result 只认 `_tag` 与随之而来的
 * 字符串字段，读不出来就整体降级成一条明确的失败结果。
 *
 * 与 metadata 那道收敛（wellFormedPhases/wellFormedBoard）同源，但覆盖剩下的一层：
 * `{_tag:'error', error:{code:500}}` 会在 toolError 的 `output.error.trim()` 处抛
 * TypeError；`{_tag:'success', output:{…}}` 会被当 React child 渲染成
 * `Objects are not valid as a React child`；`_tag` 拼错则一路落到
 * `STATUS_ICON[undefined]` + 空正文。三者都发生在**渲染期**，而 ErrorBoundary 裹的
 * 是整个应用壳（src/web/App.tsx）——一条脏结果换来「页面渲染出错」，会话再也打不开。
 *
 * 归一化发生在渲染边界（normalizeParts），持久化的事实不动；丢掉的信息由
 * UNREADABLE_RESULT_TEXT 明说。
 */
export function sanitizeToolResult(raw: unknown): ToolResult {
  const unreadable = (): ToolResult => ({ _tag: 'error', error: UNREADABLE_RESULT_TEXT })
  if (!isRecord(raw)) return unreadable()
  const metadata = isRecord(raw.metadata) ? raw.metadata : undefined
  switch (raw._tag) {
    case 'success': {
      const output = str(raw.output)
      if (output === undefined) return unreadable()
      return metadata ? { _tag: 'success', output, metadata } : { _tag: 'success', output }
    }
    case 'truncated': {
      const output = str(raw.output)
      if (output === undefined) return unreadable()
      // totalLines 缺失/非数字时给 0（未知）——toolTruncated 对 0 不再写「共 0 行」。
      const totalLines =
        typeof raw.totalLines === 'number' && Number.isFinite(raw.totalLines) ? raw.totalLines : 0
      return {
        _tag: 'truncated',
        output,
        truncated: raw.truncated === true,
        totalLines,
        ...(metadata ? { metadata } : {}),
      }
    }
    case 'error': {
      const error = str(raw.error)
      if (error === undefined) return unreadable()
      return metadata ? { _tag: 'error', error, metadata } : { _tag: 'error', error }
    }
    case 'permission_required': {
      const reason = str(raw.reason)
      return reason === undefined ? unreadable() : { _tag: 'permission_required', reason }
    }
    default:
      return unreadable()
  }
}

export type TodoPhaseLike = { name: string; tasks: { content: string; status: string }[] }

export type BoardLike = {
  columns: { id: string; name: string }[]
  cards: {
    id: string
    title: string
    columnId: string
    priority: 'high' | 'medium' | 'low'
    description: string | null
  }[]
}

/** tool_result.metadata.phases → 可渲染的阶段列表（畸形 phase/task 整条丢弃）。 */
export function wellFormedPhases(raw: unknown): Sanitized<TodoPhaseLike[]> {
  if (raw === undefined || raw === null) return { value: [], dropped: 0, malformed: false }
  if (!Array.isArray(raw)) return { value: [], dropped: 0, malformed: true }
  let dropped = 0
  const phases: TodoPhaseLike[] = []
  for (const p of raw) {
    if (!isRecord(p) || typeof p.name !== 'string' || !Array.isArray(p.tasks)) {
      dropped++
      continue
    }
    const tasks: TodoPhaseLike['tasks'] = []
    for (const t of p.tasks) {
      if (!isRecord(t) || typeof t.content !== 'string') {
        dropped++
        continue
      }
      tasks.push({ content: t.content, status: str(t.status) ?? 'pending' })
    }
    phases.push({ name: p.name, tasks })
  }
  return { value: phases, dropped, malformed: false }
}

/** tool_result.metadata.board → 可渲染的看板（畸形列/卡片整条丢弃）。 */
export function wellFormedBoard(raw: unknown): Sanitized<BoardLike> {
  const empty: Sanitized<BoardLike> = {
    value: { columns: [], cards: [] },
    dropped: 0,
    malformed: false,
  }
  if (raw === undefined || raw === null) return empty
  if (!isRecord(raw)) return { value: empty.value, dropped: 0, malformed: true }
  let dropped = 0
  const columns: BoardLike['columns'] = []
  if (Array.isArray(raw.columns)) {
    for (const c of raw.columns) {
      if (!isRecord(c) || typeof c.id !== 'string' || typeof c.name !== 'string') {
        dropped++
        continue
      }
      columns.push({ id: c.id, name: c.name })
    }
  } else if (raw.columns !== undefined) {
    dropped++
  }
  const cards: BoardLike['cards'] = []
  if (Array.isArray(raw.cards)) {
    for (const c of raw.cards) {
      if (
        !isRecord(c) ||
        typeof c.id !== 'string' ||
        typeof c.title !== 'string' ||
        typeof c.columnId !== 'string'
      ) {
        dropped++
        continue
      }
      cards.push({
        id: c.id,
        title: c.title,
        columnId: c.columnId,
        priority: c.priority === 'high' || c.priority === 'medium' ? c.priority : 'low',
        description: str(c.description) ?? null,
      })
    }
  } else if (raw.cards !== undefined) {
    dropped++
  }
  return { value: { columns, cards }, dropped, malformed: false }
}
