# 终端按项目隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让终端实例绑定到项目——切换项目即切换可见终端集合，PTY 进程保留存活切回可恢复，且未开过终端的项目面板默认关闭。

**Architecture:** 后端 PTYInfo 增加 `projectId` 字段作为归属权威；前端 `useTerminal(projectId)` 按项目分桶持久化 sessions 布局与面板开关状态，切换项目时断开 WebSocket、清空状态、按后端 projectId 过滤重建。hook 自动将 projectId 注入所有 create/split 调用，无需调用方传递。

**Tech Stack:** TypeScript, Hono, node-pty, React 19, Vitest, localStorage, WebSocket

**Spec:** `docs/superpowers/specs/2026-07-13-terminal-project-binding-design.md`

---

## File Structure

| 文件 | 责任 | 改动类型 |
|---|---|---|
| `src/server/terminal/pty-manager.ts` | PTY 生命周期：PTYInfo/CreatePTYOptions 加 projectId，create 写入 | Modify |
| `src/server/routes/terminal.ts` | POST 透传 body.projectId | Modify |
| `src/server/routes/terminal.test.ts` | projectId 创建/列出用例 | Modify |
| `src/web/services/terminal.ts` | 前端 TerminalInfo + create params 加 projectId | Modify |
| `src/web/hooks/useTerminal.ts` | 签名加 projectId；sessions+open 分桶；切换恢复 | Modify |
| `src/web/hooks/useTerminal.test.ts` | 项目隔离测试（新文件） | Create |
| `src/web/App.tsx` | `useTerminal(projectId)`，TerminalPanel 传 projectId | Modify |
| `src/web/components/TerminalPanel.tsx` | props 加 projectId，切换时重置 autoCreatedRef | Modify |

---

## Task 1: 后端 PTY 携带 projectId

**Files:**
- Modify: `src/server/terminal/pty-manager.ts:11-12, 31-35, 76-89`
- Modify: `src/server/routes/terminal.ts:18-28`
- Test: `src/server/routes/terminal.test.ts`

- [ ] **Step 1: 写失败测试——POST 带 projectId**

在 `src/server/routes/terminal.test.ts` 的 `describe('terminal route', ...)` 块内、最后一个 `it(...)` 之后、闭合 `})` 之前，添加两个用例：

```typescript
  it('POST / with projectId stores and returns it', async () => {
    const { app, ctx } = setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-xyz' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.id).toMatch(/^pty_/)
    expect(body.projectId).toBe('proj-xyz')
    ctx.ptyManager.kill(body.id as string)
  })

  it('POST / without projectId returns undefined projectId', async () => {
    const { app, ctx } = setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.projectId).toBeUndefined()
    ctx.ptyManager.kill(body.id as string)
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/server/routes/terminal.test.ts -t "projectId"`
Expected: FAIL — `body.projectId` is `undefined` for both cases（PTYInfo 尚无 projectId 字段）。

- [ ] **Step 3: 实现——PTYInfo / CreatePTYOptions 加 projectId**

修改 `src/server/terminal/pty-manager.ts`。

PTYInfo 接口（第 11 行附近），在 `shell: string` 后加：

```typescript
export interface PTYInfo {
  id: string
  pid: number
  title: string
  cols: number
  rows: number
  cwd: string
  /** shell 程序路径。 */
  shell: string
  /** 所属项目 id（未归属时为 undefined）。 */
  projectId?: string
}
```

CreatePTYOptions 接口（第 31 行附近），在 `shell?: string` 后加：

```typescript
export interface CreatePTYOptions {
  cwd: string
  cols?: number
  rows?: number
  title?: string
  /** 覆盖默认 shell；不传则自动检测。 */
  shell?: string
  /** 所属项目 id。 */
  projectId?: string
}
```

`create()` 方法（第 76 行附近），在构建 `info` 对象时加 `projectId`：

```typescript
    const info: PTYInfo = {
      id,
      pid: pty.pid,
      title: truncateTitle(opts.title ?? shell),
      cols,
      rows,
      cwd: opts.cwd,
      shell,
      projectId: opts.projectId,
    }
```

- [ ] **Step 4: 实现——路由透传 projectId**

修改 `src/server/routes/terminal.ts` 的 POST handler（第 18 行附近），在 `const shell = ...` 之后、`try` 之前加一行，并在 `mgr.create(...)` 调用中传入：

```typescript
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const cwd = typeof body.cwd === 'string' && body.cwd.length > 0 ? body.cwd : ctx.cwd
    const cols = Number.isFinite(body.cols) ? Number(body.cols) : undefined
    const rows = Number.isFinite(body.rows) ? Number(body.rows) : undefined
    const title = typeof body.title === 'string' ? body.title : undefined
    const shell = typeof body.shell === 'string' && body.shell.length > 0 ? body.shell : undefined
    const projectId = typeof body.projectId === 'string' && body.projectId.length > 0 ? body.projectId : undefined

    try {
      const info = mgr.create({ cwd, cols, rows, title, shell, projectId })
      return c.json(info, 201)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create terminal'
      return apiError(c, 500, 'PTY_CREATE_FAILED', message)
    }
  })
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run src/server/routes/terminal.test.ts`
Expected: PASS — 全部用例通过（含新增 2 个）。

- [ ] **Step 6: 提交**

```bash
git add src/server/terminal/pty-manager.ts src/server/routes/terminal.ts src/server/routes/terminal.test.ts
git commit -m "feat(server): PTYInfo 携带 projectId 作为终端归属权威"
```

---

## Task 2: 前端 TerminalInfo + create params 加 projectId

**Files:**
- Modify: `src/web/services/terminal.ts:3-11, 13-16`

- [ ] **Step 1: 修改 TerminalInfo 接口**

`src/web/services/terminal.ts`，在 `shell: string` 后加 `projectId`：

```typescript
export interface TerminalInfo {
  id: string
  pid: number
  title: string
  cols: number
  rows: number
  cwd: string
  shell: string
  /** 所属项目 id（未归属时为 undefined）。 */
  projectId?: string
}
```

- [ ] **Step 2: 修改 create params 类型**

同文件，`create` 的 params 加 `projectId?: string`：

```typescript
  create: (params?: { cwd?: string; cols?: number; rows?: number; title?: string; shell?: string; projectId?: string }) =>
    apiRequest<TerminalInfo>('/api/terminal', {
      method: 'POST',
      body: JSON.stringify(params ?? {}),
    }),
```

- [ ] **Step 3: 类型检查**

Run: `pnpm tsc --noEmit -p src/web/tsconfig.json`
Expected: PASS — 无类型错误。

- [ ] **Step 4: 提交**

```bash
git add src/web/services/terminal.ts
git commit -m "feat(web): TerminalInfo 增加 projectId 字段"
```

---

## Task 3: 前端 hook — useTerminal(projectId) 项目隔离

这是核心改动。hook 接收 `projectId`，将 sessions 布局与面板开关状态按项目分桶持久化，切换项目时按后端 projectId 过滤重建。

**Files:**
- Modify: `src/web/hooks/useTerminal.ts`
- Test: `src/web/hooks/useTerminal.test.ts`（新建）

- [ ] **Step 1: 写失败测试——createTerminal 注入 projectId**

创建 `src/web/hooks/useTerminal.test.ts`：

```typescript
// src/web/hooks/useTerminal.test.ts
// 来源：终端按项目隔离需求。终端 hook 此前无测试文件，故新建。

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreate = vi.fn()
const mockList = vi.fn()
const mockKill = vi.fn()
vi.mock('../services/terminal.js', () => ({
  terminalAPI: {
    list: () => mockList(),
    create: (params?: object) => mockCreate(params),
    get: vi.fn(),
    resize: vi.fn(),
    kill: (id: string) => mockKill(id),
  },
  terminalWsUrl: (id: string) => `ws://localhost/${id}`,
}))

import { useTerminal } from './useTerminal.js'

function fakeInfo(id: string, projectId?: string) {
  return {
    id,
    pid: 1,
    title: 'sh',
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    shell: '/bin/bash',
    ...(projectId !== undefined ? { projectId } : {}),
  }
}

beforeEach(() => {
  localStorage.clear()
  mockCreate.mockReset()
  mockList.mockReset()
  mockKill.mockReset()
  mockList.mockResolvedValue({ terminals: [] })
})

afterEach(() => {
  localStorage.clear()
})

/** 向 localStorage 写入某项目的终端布局。 */
function seedLayout(projectId: string, sessionIds: string[]) {
  const sessions = sessionIds.map((id) => ({ id, tabId: id }))
  const tabSplits: Record<string, { direction: 'horizontal'; sizes: number[] }> = {}
  for (const id of sessionIds) tabSplits[id] = { direction: 'horizontal', sizes: [1] }
  localStorage.setItem(
    `c0de-agent:terminalSessions:${projectId}`,
    JSON.stringify({
      sessions,
      tabSplits,
      activeTabId: sessionIds[0] ?? null,
      activePaneId: sessionIds[0] ?? null,
    }),
  )
}

describe('useTerminal 项目隔离', () => {
  it('createTerminal 将 projectId 传给后端', async () => {
    mockCreate.mockResolvedValue(fakeInfo('pty_1', 'projA'))
    const { result } = renderHook(() => useTerminal('projA'))

    // 等待 mount 恢复完成（无 localStorage，立即完成）
    await act(async () => {})

    await act(async () => {
      await result.current.createTerminal({ cwd: '/tmp' })
    })

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'projA', cwd: '/tmp' }),
    )
  })

  it('后端 projectId 为权威：localStorage 含 pty_A 但后端归属 projA，切到 projB 不恢复', async () => {
    // projB 的 localStorage 误含 pty_A（模拟脏数据/多标签页串扰）
    seedLayout('projB', ['pty_A'])
    // 后端说 pty_A 属于 projA
    mockList.mockResolvedValue({ terminals: [fakeInfo('pty_A', 'projA')] })

    const { result } = renderHook(() => useTerminal('projB'))
    await act(async () => {})

    // projB localStorage 有 pty_A，但后端归属是 projA → 不恢复
    expect(result.current.sessions).toHaveLength(0)
    expect(result.current.restoring).toBe(false)
  })

  it('切到另一项目再切回，恢复原项目终端', async () => {
    seedLayout('projA', ['pty_A'])
    mockList.mockResolvedValue({ terminals: [fakeInfo('pty_A', 'projA')] })

    const { result, rerender } = renderHook(({ pid }) => useTerminal(pid), {
      initialProps: { pid: 'projA' },
    })
    await act(async () => {})
    expect(result.current.sessions).toHaveLength(1)

    // 切到 projB（无终端）
    rerender({ pid: 'projB' })
    await act(async () => {})
    expect(result.current.sessions).toHaveLength(0)

    // 切回 projA
    rerender({ pid: 'projA' })
    await act(async () => {})

    expect(result.current.sessions).toHaveLength(1)
    expect(result.current.sessions[0]?.id).toBe('pty_A')
    expect(result.current.sessions[0]?.projectId).toBe('projA')
  })

  it('切到无终端记录的项目 open 为 false', async () => {
    const { result } = renderHook(() => useTerminal('newProj'))
    await act(async () => {})
    expect(result.current.open).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/web/hooks/useTerminal.test.ts`
Expected: FAIL — `createTerminal` 不传 projectId（`mockCreate` 未收到 projectId），切换项目时 restore effect 依赖 `[]` 不重新执行，无法按项目过滤/恢复。

- [ ] **Step 3: 实现——localStorage key 改为按项目分桶**

修改 `src/web/hooks/useTerminal.ts`。

将三个 key 常量（第 21-23 行附近）替换为函数：

```typescript
const TERMINAL_HEIGHT_KEY = 'c0de-agent:terminalHeight'
/** 面板开关状态：按项目分桶。 */
const openKey = (projectId: string) => `c0de-agent:terminalOpen:${projectId}`
/** 终端布局：按项目分桶。 */
const sessionsKey = (projectId: string) => `c0de-agent:terminalSessions:${projectId}`
```

（删除原 `TERMINAL_OPEN_KEY` 和 `TERMINAL_SESSIONS_KEY` 常量。）

- [ ] **Step 4: 实现——loadOpen / loadPersistedState / savePersistedState 接收 projectId**

同文件，将这三个函数改为接收 projectId 参数：

```typescript
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
```

- [ ] **Step 5: 实现——hook 签名 + projectIdRef + open 初始值**

将 `export function useTerminal() {` 改为：

```typescript
export function useTerminal(projectId: string) {
```

在函数体最开头（`const [sessions, setSessions]` 之前）加 projectIdRef：

```typescript
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId
```

将 open 初始值改为按项目读取（找到 `const [open, setOpen] = useState(loadOpen)`）：

```typescript
  const [open, setOpen] = useState(() => loadOpen(projectId))
```

- [ ] **Step 6: 实现——createTerminal 注入 projectId**

找到 `createTerminal` 的 `const info = await terminalAPI.create(opts)`，改为：

```typescript
      const info = await terminalAPI.create({ ...opts, projectId: projectIdRef.current })
```

- [ ] **Step 7: 实现——splitTerminal 注入 projectId**

找到 `splitTerminal` 的 `const info = await terminalAPI.create(opts)`，改为：

```typescript
      const info = await terminalAPI.create({ ...opts, projectId: projectIdRef.current })
```

- [ ] **Step 8: 实现——恢复 effect 改为 [projectId] 依赖 + 切换重建**

将现有的恢复 `useEffect`（依赖 `[]`，开头注释 `// ---- 恢复：`）整体替换为：

```typescript
  // ---- 恢复：projectId 变化时按项目重建终端结构 ----
  useEffect(() => {
    const pid = projectId
    let cancelled = false
    setRestoring(true)
    // 断开当前所有 WebSocket（PTY 在后端保持存活，切回可重连）
    for (const s of sessionsRef.current) {
      s.ws?.close()
    }
    // 清空当前项目状态
    setSessions([])
    setTabSplits({})
    setActiveTabId(null)
    setActivePaneId(null)
    // 恢复该项目的面板开关状态（无记录默认关闭）
    setOpen(loadOpen(pid))

    void (async () => {
      const persisted = loadPersistedState(pid)
      if (!persisted?.sessions.length) {
        if (!cancelled) setRestoring(false)
        return
      }
      try {
        const { terminals } = await terminalAPI.list()
        if (cancelled) return
        // 后端 projectId 为权威：仅归属当前项目的存活 PTY
        const liveIds = new Set(
          terminals.filter((t) => t.projectId === pid).map((t) => t.id),
        )
        const restored = persisted.sessions
          .filter((ps) => liveIds.has(ps.id))
          .map((ps) => {
            const info = terminals.find((t) => t.id === ps.id)!
            return {
              ...info,
              ws: null,
              connecting: false,
              tabId: ps.tabId,
            } satisfies TerminalSession
          })
        if (restored.length === 0) {
          if (!cancelled) setRestoring(false)
          return
        }
        // 重建 tabSplits，只保留仍有 pane 的 tab
        const liveTabIds = new Set(restored.map((s) => s.tabId))
        const restoredSplits: Record<string, TabSplit> = {}
        for (const [tabId, split] of Object.entries(persisted.tabSplits)) {
          if (liveTabIds.has(tabId)) {
            const paneCount = restored.filter((s) => s.tabId === tabId).length
            restoredSplits[tabId] = {
              direction: split.direction,
              sizes: reconcileSizes(split.sizes, paneCount),
            }
          }
        }
        setSessions(restored)
        setTabSplits(restoredSplits)

        // 恢复 activeTabId / activePaneId，无效则回退到第一个
        const validTabId =
          persisted.activeTabId && liveTabIds.has(persisted.activeTabId)
            ? persisted.activeTabId
            : restored[0]!.tabId
        const validPaneId =
          persisted.activePaneId && restored.some((s) => s.id === persisted.activePaneId)
            ? persisted.activePaneId
            : restored.find((s) => s.tabId === validTabId)?.id ?? null
        setActiveTabId(validTabId)
        setActivePaneId(validPaneId)
      } catch {
        // 后端不可用，不恢复任何会话
      } finally {
        if (!cancelled) setRestoring(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId])
```

- [ ] **Step 9: 实现——持久化 effect 传 projectId**

将持久化 `useEffect` 中的 `savePersistedState(...)` 调用改为：

```typescript
  useEffect(() => {
    if (restoring) return
    savePersistedState(
      {
        sessions: sessions.map((s) => ({ id: s.id, tabId: s.tabId })),
        tabSplits,
        activeTabId,
        activePaneId,
      },
      projectIdRef.current,
    )
  }, [restoring, sessions, tabSplits, activeTabId, activePaneId])
```

- [ ] **Step 10: 实现——toggleOpen 写入项目级 key**

将 `toggleOpen` 改为写入项目级 key：

```typescript
  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev
      localStorage.setItem(openKey(projectIdRef.current), String(next))
      return next
    })
  }, [])
```

- [ ] **Step 11: 运行测试确认通过**

Run: `pnpm vitest run src/web/hooks/useTerminal.test.ts`
Expected: PASS — 全部 4 个用例通过。

- [ ] **Step 12: 提交**

```bash
git add src/web/hooks/useTerminal.ts src/web/hooks/useTerminal.test.ts
git commit -m "feat(web): useTerminal 按项目隔离 sessions 与面板开关"
```

---

## Task 4: 前端组件接线——传递 projectId

**Files:**
- Modify: `src/web/App.tsx`（ChatPage 内）
- Modify: `src/web/components/TerminalPanel.tsx`

- [ ] **Step 1: App.tsx 传递 projectId 给 hook**

`src/web/App.tsx`，ChatPage 函数内，将 `const terminal = useTerminal()` 改为：

```typescript
  const terminal = useTerminal(projectId!)
```

（`projectId` 来自路由 `useParams`，在 `/projects/:projectId` 路由下必有值。`projectId!` 是 TypeScript 非空断言。）

- [ ] **Step 2: App.tsx 传递 projectId 给 TerminalPanel**

同文件，找到 `<TerminalPanel terminal={terminal} cwd={project?.worktree} />`，改为：

```tsx
          terminal={<TerminalPanel terminal={terminal} cwd={project?.worktree} projectId={projectId} />}
```

- [ ] **Step 3: TerminalPanel props 加 projectId**

`src/web/components/TerminalPanel.tsx`，将 `TerminalPanelProps` 接口改为：

```typescript
interface TerminalPanelProps {
  terminal: UseTerminalReturn
  /** 新终端的默认工作目录（通常为项目 worktree）。未提供时使用服务端默认。 */
  cwd?: string
  /** 当前项目 id（用于切换项目时重置自动创建标记）。 */
  projectId: string
}
```

将主组件函数签名改为解构 projectId：

```typescript
export function TerminalPanel({ terminal, cwd, projectId }: TerminalPanelProps) {
```

- [ ] **Step 4: TerminalPanel 切换项目时重置 autoCreatedRef**

在 `autoCreatedRef` 声明（`const autoCreatedRef = useRef(false)`）之后、自动创建 effect 之前，加一个 effect：

```typescript
  // 切换项目时重置自动创建标记，允许新项目在面板打开时创建首个终端
  useEffect(() => {
    autoCreatedRef.current = false
  }, [projectId])
```

- [ ] **Step 5: 类型检查**

Run: `pnpm tsc --noEmit -p src/web/tsconfig.json`
Expected: PASS — 无类型错误。

- [ ] **Step 6: 提交**

```bash
git add src/web/App.tsx src/web/components/TerminalPanel.tsx
git commit -m "feat(web): 终端面板接线 projectId，切换项目重置自动创建"
```

---

## Task 5: 全量验证

- [ ] **Step 1: 运行终端相关全部测试**

Run: `pnpm vitest run src/server/routes/terminal.test.ts src/web/hooks/useTerminal.test.ts`
Expected: PASS — 全部通过。

- [ ] **Step 2: 运行全量类型检查**

Run: `pnpm tsc --noEmit`
Expected: PASS — 无类型错误。

- [ ] **Step 3: 运行受影响的前端组件测试**

Run: `pnpm vitest run src/web/components/ src/web/App.tsx 2>/dev/null; pnpm vitest run --dir src/web`
Expected: PASS — 无回归。

- [ ] **Step 4: 手动验证（可选，需 dev server）**

1. `pnpm dev` 启动前后端
2. 打开项目 A，Ctrl+` 打开终端面板，确认自动创建了 A 目录下的 shell
3. 通过项目切换器切到项目 B，确认终端面板关闭（未开过终端）
4. 在 B 中 Ctrl+` 打开面板，确认自动创建 B 目录下的 shell
5. 切回 A，确认 A 的终端恢复（含 shell 现场），B 的终端隐藏但进程存活

如不可手动验证，标注 `[手动验证待执行]` 并说明验证步骤。
