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
  /** 会话树查询的完整返回值：驱动读失败分支与「重试」入口。 */
  treeQuery: {
    data: [] as unknown[] | undefined,
    isLoading: false,
    isError: false,
    error: null as unknown,
    refetch: () => {},
  },
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
  useSessionTree: () => {
    if (hoisted.treeQuery.isError) return hoisted.treeQuery
    return { ...hoisted.treeQuery, data: hoisted.tree }
  },
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
  hoisted.treeQuery = {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: () => {},
  }
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

  /**
   * 回归：单字符查询此前被静默丢弃。
   *
   * 缺陷：内容搜索 query 的 enabled 是 `searchDebounced.length > 1`，
   * 而标题树 searchTree 对 1 个字照常过滤。于是「只命中消息内容、不命中
   * 标题」的会话在输入 1 个字时直接变成「无匹配会话」——服务端其实查得到。
   * 实测：搜「独」报无匹配，搜「独特」即命中。
   *
   * 断言打在「1 个字也必须真的发请求」上：这是丢结果与不丢结果的分界点，
   * 比断言渲染出的行数更贴近根因。
   */
  it('单字符查询也会真正发起服务端搜索（不静默丢弃）', async () => {
    renderList()
    fireEvent.change(screen.getByTestId('session-search'), { target: { value: '独' } })

    await waitFor(
      () => {
        expect(vi.mocked(sessionAPI.search)).toHaveBeenCalledWith('独', 'p1')
      },
      { timeout: 2000 },
    )
    // 命中结果须真的进列表，而不是「无匹配会话」
    await waitFor(() => {
      expect(screen.getByTestId('content-match-outside-id')).toBeInTheDocument()
    })
    expect(screen.queryByText('无匹配会话')).toBeNull()
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

describe('SessionList 读失败态', () => {
  it('读失败不得伪装成「该项目下暂无会话」，且展示后端 message 与重试入口', () => {
    hoisted.treeQuery = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 500, code: 'DB_LOCKED', message: '数据库被占用，请稍后重试' },
      refetch: () => {},
    }
    renderList()
    const bar = screen.getByTestId('sessions-load-error')
    expect(bar.textContent).toContain('数据库被占用，请稍后重试')
    expect(bar.textContent).not.toContain('[object Object]')
    // 关键：拉不到 ≠ 空的。空态必须缺席，否则用户以为会话已被清空。
    expect(screen.queryByText('该项目下暂无会话')).toBeNull()
    expect(screen.getByTestId('sessions-retry')).toBeInTheDocument()
  })

  it('重试按钮回调 refetch', () => {
    const refetch = vi.fn()
    hoisted.treeQuery = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 500, message: 'boom' },
      refetch,
    }
    renderList()
    fireEvent.click(screen.getByTestId('sessions-retry'))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('正常状态下仍展示会话树，不显示错误态', () => {
    hoisted.treeQuery = {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    }
    renderList()
    expect(screen.queryByTestId('sessions-load-error')).toBeNull()
    expect(screen.getByText(ROOT.title)).toBeInTheDocument()
  })
})

/**
 * 回收站搜索：单字符查询不得被静默丢弃。
 *
 * 缺陷比会话列表更重一层：这里有**两处**独立的 `length > 1`——query 的
 * enabled 与「是否在搜索」的 rows 分支。两处同时为假时，搜索框里有字，
 * 列表却原样列出未过滤的全部分页条目，用户看不到任何收敛，只以为搜索没生效。
 * 两处口径必须一致，故抽取 isSearching 复用。
 */
describe('RecycleBin 搜索', () => {
  function renderTrashSearch() {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    return render(
      <QueryClientProvider client={qc}>
        <RecycleBin projectId="p1" />
      </QueryClientProvider>,
    )
  }

  it('单字符查询发起服务端搜索，且列表只列命中项', async () => {
    const hit = makeSession('hit-id', '命中标题')
    hoisted.deleted = {
      data: [makeSession('other-id', '别的会话'), hit],
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    }
    vi.mocked(sessionAPI.search).mockResolvedValue({
      results: [{ session: hit, matchedBy: 'title' }],
    })
    renderTrashSearch()

    fireEvent.change(screen.getByTestId('trash-search'), { target: { value: '命' } })
    await waitFor(
      () => {
        expect(vi.mocked(sessionAPI.search)).toHaveBeenCalledWith('命', 'p1', true)
      },
      { timeout: 2000 },
    )
    // 单字符也走「搜索中」的结果分支：未命中的条目不得混进来
    await waitFor(() => {
      expect(screen.getByText('命中标题')).toBeInTheDocument()
    })
    expect(screen.queryByText('别的会话')).toBeNull()
  })
})
