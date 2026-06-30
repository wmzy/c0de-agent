const MAX_HISTORY = 100
const HISTORY_KEY = 'composer-history.v1'

/**
 * 判断当前是否可在该方向触发历史回溯。
 *  up：光标须在第一行（光标前无换行）。
 *  down：须已在历史回溯中（inHistory），且光标在最后一行（光标后无换行）。
 */
function canNavigateHistoryAtCursor(
  direction: 'up' | 'down',
  text: string,
  cursor: number,
  inHistory = false,
): boolean {
  if (direction === 'up') {
    const lastNewlineBefore = text.lastIndexOf('\n', cursor - 1)
    return lastNewlineBefore === -1 // 光标前无换行 → 第一行
  }
  // down
  if (!inHistory) return false
  const nextNewline = text.indexOf('\n', cursor)
  return nextNewline === -1 // 光标后无换行 → 最后一行
}

type HistoryNavResult = { entry: string; index: number } | { reset: true }

/** 在历史中导航。currentIndex=-1 表示空闲态（未进入历史）。 */
function navigatePromptHistory(input: {
  entries: string[]
  currentIndex: number
  direction: 'up' | 'down'
  draft: string
}): HistoryNavResult | null {
  const { entries, currentIndex, direction } = input
  if (entries.length === 0) return null

  if (direction === 'up') {
    const next = currentIndex === -1 ? entries.length - 1 : Math.max(0, currentIndex - 1)
    return { entry: entries[next] ?? '', index: next }
  }
  // down
  if (currentIndex === -1) return null
  const next = currentIndex + 1
  if (next >= entries.length) return { reset: true }
  return { entry: entries[next] ?? '', index: next }
}

/** 发送后将文本加入历史。去重（与最新相同则不插）、截断上限、忽略空白。 */
function prependHistoryEntry(entries: string[], text: string, max = MAX_HISTORY): string[] {
  const trimmed = text.trim()
  if (!trimmed) return entries
  if (entries[0] === trimmed) return entries
  return [trimmed, ...entries].slice(0, max)
}

/** 从 localStorage 读取历史。 */
function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 持久化历史到 localStorage。 */
function saveHistory(entries: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY)))
  } catch {
    // 忽略 quota/隐私模式错误
  }
}

export {
  canNavigateHistoryAtCursor,
  HISTORY_KEY,
  loadHistory,
  MAX_HISTORY,
  navigatePromptHistory,
  prependHistoryEntry,
  saveHistory,
}
