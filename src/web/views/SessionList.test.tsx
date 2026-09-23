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
import { SessionList } from '@/views/SessionList.js'

const hoisted = vi.hoisted(() => ({ tree: [] as unknown[] }))

vi.mock('@/hooks/useSession.js', () => ({
  useSessionTree: () => ({ data: hoisted.tree, isLoading: false }),
  useDeleteSession: () => ({ mutate: vi.fn() }),
  useProjects: () => ({ data: [{ id: 'p1', name: 'proj', worktree: '/tmp/proj' }] }),
  useDeletedSessions: () => ({ data: [], isLoading: false }),
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
