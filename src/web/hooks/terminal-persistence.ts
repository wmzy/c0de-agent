// src/web/hooks/terminal-persistence.ts
// 终端面板状态的 localStorage 持久化与纯函数工具。
// 从 useTerminal.ts 拆出：常量、key 派生、读写、sizes 归一化。

const TERMINAL_HEIGHT_KEY = 'c0de-agent:terminalHeight'
const DEFAULT_HEIGHT = 240
const MIN_HEIGHT = 100
const MAX_HEIGHT = 800

/** 面板开关状态：按项目分桶。 */
const openKey = (projectId: string) => `c0de-agent:terminalOpen:${projectId}`
/** 终端布局：按项目分桶。 */
const sessionsKey = (projectId: string) => `c0de-agent:terminalSessions:${projectId}`

/** 持久化到 localStorage 的最小终端结构（不含 WS 对象）。 */
interface PersistedTerminalState {
  sessions: Array<{ id: string; tabId: string }>
  tabSplits: Record<string, { direction: 'horizontal' | 'vertical'; sizes: number[] }>
  activeTabId: string | null
  activePaneId: string | null
}

/** pane 最小 flex 比例（防止被拖到 0）。 */
const MIN_PANE_FLEX = 0.15

function loadHeight(): number {
  const raw = localStorage.getItem(TERMINAL_HEIGHT_KEY)
  if (raw == null) return DEFAULT_HEIGHT
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, n)) : DEFAULT_HEIGHT
}

function loadOpen(projectId: string): boolean {
  return localStorage.getItem(openKey(projectId)) === 'true'
}

function loadPersistedState(projectId: string): PersistedTerminalState | null {
  try {
    const raw = localStorage.getItem(sessionsKey(projectId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedTerminalState
    if (!parsed?.sessions || !Array.isArray(parsed.sessions)) return null
    return parsed
  } catch {
    return null
  }
}

function savePersistedState(state: PersistedTerminalState, projectId: string): void {
  try {
    localStorage.setItem(sessionsKey(projectId), JSON.stringify(state))
  } catch {
    // localStorage 满或不可用，忽略
  }
}

/** 确保 sizes 数组长度与 pane 数量一致，且归一化为均值 1.0。
 *  归一化后每个 pane 的 flex-grow ≈ 1.0，浏览器会正确分配空间。
 *  不归一化时（如 [0.5]），单个 pane 的 flex-grow:0.5 只占 50% 而非 100%。 */
function reconcileSizes(sizes: number[], count: number): number[] {
  let arr: number[]
  if (sizes.length === count) {
    arr = sizes
  } else if (sizes.length > count) {
    arr = sizes.slice(0, count)
  } else {
    arr = [...sizes, ...Array(count - sizes.length).fill(1)]
  }
  // 归一化：使总和 = count（均值 1.0）
  const sum = arr.reduce((a, b) => a + b, 0)
  if (sum <= 0) return arr.map(() => 1)
  return arr.map((s) => (s * count) / sum)
}

export type { PersistedTerminalState }
export {
  DEFAULT_HEIGHT,
  loadHeight,
  loadOpen,
  loadPersistedState,
  MAX_HEIGHT,
  MIN_HEIGHT,
  MIN_PANE_FLEX,
  openKey,
  reconcileSizes,
  savePersistedState,
  sessionsKey,
  TERMINAL_HEIGHT_KEY,
}
