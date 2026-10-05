/**
 * SessionList 会话搜索语义：标题命中的会话整棵子树在树中展示；
 * 「消息内容匹配」区只补充**树里看不到**的会话（不能把树中已显示的深层后代
 * 再列一遍）。
 */
import type { Session } from '@shared/types/message.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionAPI } from '@/services/session.js'
import type { SessionTreeNode } from '@/types/index.js'
import { RecycleBin } from '@/views/RecycleBin.js'
import { SessionList } from '@/views/SessionList.js'

const hoisted = vi.hoisted(() => ({
  tree: [] as unknown[],
  /** 覆盖 useDeletedSessions 的返回值，用于驱动回收站的加载失败分支。 */
  deleted: {
    // 读失败时 react-query 的 data 确实为 undefined，这里必须允许。
    data: [] as unknown[] | undefined,
    isLoading: false,
    isError: false,
    error: null as unknown,
    refetch: () => {},
  },
}))

vi.mock('@/hooks/useSession.js', () => ({
  useSessionTree: () => ({ data: hoisted.tree, isLoading: false }),
  useDeleteSession: () => ({ mutate: vi.fn() }),
  useProjects: () => ({ data: [{ id: 'p1', name: 'proj', worktree: '/tmp/proj' }] }),
  useDeletedSessions: () => hoisted.deleted,
  useDeletedOrphansCount: () => ({ data: { count: 0 } }),
  useDeletedOrphans: () => ({ data: [] }),
  useRestoreSession: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/services/session.js', () => ({
  sessionAPI: {
    search: vi.fn(),
    rename: vi.fn(),
    importSession: vi.fn(),
  },
}))

const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheRead: 0,
  cost: 0,
  unknownCostCalls: 0,
  calls: 0,
}

function makeSession(id: string, title: string, projectId: string | null = 'p1'): Session {
  return {
    id,
    title,
    projectId,
    parentId: null,
    branchPoint: null,
    metadata: {},
    agentType: null,
    worktreePath: null,
    source: 'web',
    deletedAt: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

function node(session: Session, children: SessionTreeNode[] = []): SessionTreeNode {
  return { session, children, usage: EMPTY_USAGE }
}

/** root（标题命中搜索词）→ child → grandchild（消息内容命中）。 */
const ROOT = makeSession('root-id', 'hit-root')
const CHILD = makeSession('child-id', 'child')
const GRANDCHILD = makeSession('grandchild-id', 'grandchild')
const OUTSIDE = makeSession('outside-id', 'outside-tree')

beforeEach(() => {
  hoisted.tree = [node(ROOT, [node(CHILD, [node(GRANDCHILD)])])]
  vi.mocked(sessionAPI.search).mockResolvedValue({
    results: [
      { session: GRANDCHILD, matchedBy: 'content' },
      { session: OUTSIDE, matchedBy: 'content' },
    ],
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderList() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <SessionList projectId="p1" activeId={null} onSelect={vi.fn()} onNewSession={vi.fn()} />
    </QueryClientProvider>,
  )
}

async function searchFor(text: string) {
  fireEvent.change(screen.getByTestId('session-search'), { target: { value: text } })
  // 300ms 防抖后才触发服务端搜索
  await waitFor(
    () => {
      expect(vi.mocked(sessionAPI.search)).toHaveBeenCalledWith(text, 'p1')
    },
    { timeout: 2000 },
  )
}

describe('SessionList 会话搜索', () => {
  it('树中已展示的深层后代不再重复出现在「消息内容匹配」区', async () => {
    renderList()
    await searchFor('hit')

    // 树里能看到 root 及其全部后代（含深层 grandchild）
    expect(screen.getByTestId('node-root-id')).toBeInTheDocument()
    expect(screen.getByTestId('node-grandchild-id')).toBeInTheDocument()

    // 树外会话（未出现在树中）才进内容匹配区
    await waitFor(() => {
      expect(screen.getByTestId('content-match-outside-id')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('content-match-grandchild-id')).toBeNull()
  })
})

describe('RecycleBin 读失败态', () => {
  /** 直接渲染 RecycleBin：SessionList 里它藏在「回收站」页签后，测不到失败分支。 */
  function renderTrash() {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    return render(
      <QueryClientProvider client={qc}>
        <RecycleBin projectId="p1" />
      </QueryClientProvider>,
    )
  }

  /**
   * 回归：`instanceof Error` 对 APIError 恒为 false。
   * APIError 是结构体 { status, message, code?, details? }（services/api.ts 的
   * toAPIError 返回），不是 Error 子类，因此原先的
   * `listError instanceof Error ? listError.message : String(listError)`
   * 会渲染成「[object Object]」——错误条存在但零信息量。
   */
  it('APIError 展示后端 message，而不是 [object Object]', () => {
    hoisted.deleted = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 500, code: 'DB_LOCKED', message: '数据库被占用，请稍后重试' },
      refetch: () => {},
    }
    renderTrash()
    const bar = screen.getByTestId('trash-load-error')
    expect(bar.textContent).toContain('数据库被占用，请稍后重试')
    expect(bar.textContent).not.toContain('[object Object]')
  })

  it('非 APIError（网络异常）仍展示 Error.message', () => {
    hoisted.deleted = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new TypeError('Failed to fetch'),
      refetch: () => {},
    }
    renderTrash()
    const bar = screen.getByTestId('trash-load-error')
    expect(bar.textContent).toContain('Failed to fetch')
    expect(bar.textContent).not.toContain('[object Object]')
  })

  it('读失败不得伪装成「回收站为空」，且提供重试入口', () => {
    hoisted.deleted = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 500, message: 'boom' },
      refetch: () => {},
    }
    renderTrash()
    expect(screen.getByTestId('trash-load-error')).toBeInTheDocument()
    // 关键：拉不到 ≠ 空的。空态必须缺席，否则用户以为会话已被清空。
    expect(screen.queryByTestId('trash-empty')).toBeNull()
    expect(screen.getByTestId('trash-retry')).toBeInTheDocument()
  })

  it('重试按钮回调 refetch', () => {
    const refetch = vi.fn()
    hoisted.deleted = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 500, message: 'boom' },
      refetch,
    }
    renderTrash()
    fireEvent.click(screen.getByTestId('trash-retry'))
    expect(refetch).toHaveBeenCalledTimes(1)
  })
})
