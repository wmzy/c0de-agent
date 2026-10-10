/**
 * SessionList 会话搜索语义：标题命中的会话整棵子树在树中展示；
 * 「消息内容匹配」区只补充**树里看不到**的会话（不能把树中已显示的深层后代
 * 再列一遍）。
 */
import type { Session } from '@shared/types/message.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useMemo, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { kanbanAPI } from '@/services/kanban.js'
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
  /** 「未归属项目」分组的数据源：孤儿已删会话与其计数。 */
  orphans: { data: [] as Session[] },
  orphanCount: { data: { count: 0 } },
}))

vi.mock('@/hooks/useSession.js', () => ({
  useSessionTree: () => {
    if (hoisted.treeQuery.isError) return hoisted.treeQuery
    return { ...hoisted.treeQuery, data: hoisted.tree }
  },
  useDeleteSession: () => ({ mutate: vi.fn() }),
  useProjects: () => ({ data: [{ id: 'p1', name: 'proj', worktree: '/tmp/proj' }] }),
  useDeletedSessions: () => hoisted.deleted,
  useDeletedOrphansCount: () => hoisted.orphanCount,
  useDeletedOrphans: () => hoisted.orphans,
  useRestoreSession: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/services/session.js', () => ({
  sessionAPI: {
    search: vi.fn(),
    rename: vi.fn(),
    importSession: vi.fn(),
  },
}))

vi.mock('@/services/kanban.js', () => ({
  kanbanAPI: {
    deletedBoards: vi.fn().mockResolvedValue({ boards: [] }),
    destroyDeletedBoard: vi.fn(),
    restoreDeletedBoard: vi.fn(),
    restoreDeletedBoardToOriginal: vi.fn(),
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
  hoisted.orphans = { data: [] }
  hoisted.orphanCount = { data: { count: 0 } }
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

  /**
   * 回归：内容搜索缺三态，把「还在搜」「搜不了」都说成「无匹配会话」。
   *
   * 缺陷：query 只取 data。防抖 300ms + 请求在飞的那段时间里标题树已按
   * search 过滤、内容匹配区还是空的，于是空态分支先闪一次「无匹配会话」
   * 再翻成结果；请求失败（retry 2 次耗尽）后这一句永久停在那里，且搜索
   * 区没有任何重试入口。实测：输入「检查」瞬间侧栏报「无匹配会话」，
   * 约 1s 后才翻出「消息内容匹配」。
   */
  it('搜索在飞时报「搜索中…」，不谎报「无匹配会话」', async () => {
    let resolve: (v: unknown) => void = () => {}
    vi.mocked(sessionAPI.search).mockReturnValue(
      new Promise((r) => {
        resolve = r
      }) as never,
    )
    renderList()
    fireEvent.change(screen.getByTestId('session-search'), { target: { value: '检查' } })

    // 防抖期间（请求还没发出去）就该是「搜索中…」
    await waitFor(() => {
      expect(screen.getByText('搜索中…')).toBeInTheDocument()
    })
    expect(screen.queryByText('无匹配会话')).toBeNull()

    // 请求落地后翻成结果，不再有「搜索中…」
    resolve({ results: [{ session: OUTSIDE, matchedBy: 'content' }] })
    await waitFor(() => {
      expect(screen.getByTestId('content-match-outside-id')).toBeInTheDocument()
    })
    expect(screen.queryByText('搜索中…')).toBeNull()
  })

  it('搜索失败：给出原因与重试入口，不谎报「无匹配会话」', async () => {
    vi.mocked(sessionAPI.search).mockRejectedValue(new Error('数据库被占用，请稍后重试'))
    renderList()
    fireEvent.change(screen.getByTestId('session-search'), { target: { value: '检查' } })

    const bar = await screen.findByTestId('session-search-error')
    expect(bar.getAttribute('role')).toBe('alert')
    expect(bar.textContent).toContain('会话搜索失败')
    expect(bar.textContent).toContain('数据库被占用，请稍后重试')
    expect(screen.queryByText('无匹配会话')).toBeNull()
    expect(screen.getByTestId('session-search-retry')).toBeInTheDocument()
  })

  it('真的没有匹配时才是「无匹配会话」', async () => {
    vi.mocked(sessionAPI.search).mockResolvedValue({ results: [] })
    renderList()
    fireEvent.change(screen.getByTestId('session-search'), { target: { value: '不存在的词' } })

    await waitFor(() => {
      expect(screen.getByText('无匹配会话')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('session-search-error')).toBeNull()
  })
})

/**
 * 回归：侧栏整块内容此前不在任何 landmark 内。
 *
 * 侧栏此前只是一串无角色的 div（搜索框、标题、CLI 说明、回收站列表全都在
 * landmark 之外），读屏用户没有地标可跳，只能逐控件线性浏览几百个会话行；
 * axe region 规则在会话页报 header/搜索框/CLI 说明三处。这里约定：侧栏是
 * 一个具名 navigation 地标，标题是该页唯一的一级标题。
 */
describe('SessionList 侧栏的地标与标题', () => {
  it('侧栏是具名 navigation 地标，标题是 h1', async () => {
    renderList()
    await waitFor(() => expect(screen.getByTestId('session-search')).toBeInTheDocument())

    const landmark = screen.getByRole('navigation', { name: '会话' })
    // 搜索框与 CLI 说明必须落在这个地标里，而不是散落在 landmark 之外
    expect(landmark.contains(screen.getByTestId('session-search'))).toBe(true)
    expect(landmark.contains(screen.getByTestId('cli-session-hint'))).toBe(true)

    // 页面有且只有一个 h1，且就是侧栏标题
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
    expect(h1s[0]?.textContent).toBe('会话')
  })
})

/**
 * 回归：切项目后侧栏仍按上一个项目的搜索词过滤。
 *
 * ChatPage 对 /projects/:projectId 与 /projects/:projectId/sessions/:sessionId
 * 复用同一组件实例，param 变化不重新挂载 SessionList——search 与各种错误条
 * 都跟着上一个项目过来了。用户刚用顶栏项目下拉切过去，新项目侧栏里却留着
 * 旧查询、并被它过滤成「无匹配会话」，看着像这个项目的会话丢了。
 */
describe('SessionList 切项目', () => {
  function Switchable() {
    const [projectId, setProjectId] = useState('p1')
    const qc = useMemo(
      () =>
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        }),
      [],
    )
    return (
      <QueryClientProvider client={qc}>
        <SessionList
          projectId={projectId}
          activeId={null}
          onSelect={vi.fn()}
          onNewSession={vi.fn()}
        />
        <button type="button" data-testid="switch-project" onClick={() => setProjectId('p2')}>
          switch
        </button>
      </QueryClientProvider>
    )
  }

  it('换项目后搜索词清空，新项目的会话按自己的标题全量展示', async () => {
    const P2 = makeSession('p2-root', 'p2 会话', 'p2')
    render(<Switchable />)
    fireEvent.change(screen.getByTestId('session-search'), { target: { value: 'hit' } })
    await waitFor(() => expect(screen.getByTestId('node-root-id')).toBeInTheDocument())

    // 换项目（复用同一 SessionList 实例，只换 projectId）
    hoisted.tree = [node(P2)]
    fireEvent.click(screen.getByTestId('switch-project'))

    // 搜索词被清空（不再是 p1 的查询），p2 的会话不再被旧查询过滤掉
    await waitFor(() => {
      expect((screen.getByTestId('session-search') as HTMLInputElement).value).toBe('')
    })
    expect(screen.getByTestId('node-p2-root')).toBeInTheDocument()
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

  /**
   * 回归：搜索失败时只取 data → data 为 undefined → rows 为空数组 →
   * 「回收站无匹配会话」。用户据此认定删掉的会话已被清除。
   */
  it('搜索失败：给出原因与重试入口，不谎报「无匹配会话」', async () => {
    hoisted.deleted = {
      data: [makeSession('old-id', '旧会话')],
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    }
    vi.mocked(sessionAPI.search).mockRejectedValue(
      Object.assign(new Error('数据库被占用，请稍后重试'), { status: 500, code: 'DB_LOCKED' }),
    )
    renderTrashSearch()

    fireEvent.change(screen.getByTestId('trash-search'), { target: { value: '查不到的词' } })
    await waitFor(() => expect(screen.getByTestId('trash-search-error')).toBeInTheDocument(), {
      timeout: 2000,
    })
    const bar = screen.getByTestId('trash-search-error')
    expect(bar.getAttribute('role')).toBe('alert')
    expect(bar.textContent).toContain('回收站搜索失败')
    expect(bar.textContent).toContain('数据库被占用，请稍后重试')
    // 不得谎报「无匹配会话」
    expect(screen.queryByText('回收站无匹配会话')).toBeNull()
    // 重试入口存在
    expect(screen.getByTestId('trash-search-retry')).toBeInTheDocument()
  })

  it('搜索重试后成功：改显命中项', async () => {
    const hit = makeSession('hit-id', '命中标题')
    hoisted.deleted = {
      data: [makeSession('other-id', '别的会话'), hit],
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    }
    vi.mocked(sessionAPI.search).mockRejectedValueOnce(new Error('boom'))
    renderTrashSearch()

    fireEvent.change(screen.getByTestId('trash-search'), { target: { value: '命' } })
    await waitFor(() => expect(screen.getByTestId('trash-search-error')).toBeInTheDocument(), {
      timeout: 2000,
    })
    vi.mocked(sessionAPI.search).mockResolvedValue({
      results: [{ session: hit, matchedBy: 'title' }],
    })
    fireEvent.click(screen.getByTestId('trash-search-retry'))
    await waitFor(() => {
      expect(screen.getByText('命中标题')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('trash-search-error')).toBeNull()
  })

  it('真的没有匹配时才是「回收站无匹配会话」', async () => {
    hoisted.deleted = {
      data: [makeSession('old-id', '旧会话')],
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    }
    vi.mocked(sessionAPI.search).mockResolvedValue({ results: [] })
    renderTrashSearch()

    fireEvent.change(screen.getByTestId('trash-search'), { target: { value: '不存在的词' } })
    await waitFor(() => {
      expect(screen.getByText('回收站无匹配会话')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('trash-search-error')).toBeNull()
  })
})

/**
 * 回收站未归属看板「彻底删除」失败反馈。
 *
 * 回归：destroyBoardMut 只有 onSuccess，接口失败时看板仍在列表、
 * 屏幕上零文字——同一页面的恢复/彻底删除会话都写了错误条，只有这条漏了。
 */
describe('RecycleBin 未归属看板彻底删除', () => {
  const boards = [{ id: 'board-1', projectName: '已删项目', projectId: 'p1', cardCount: 3 }]

  function renderTrashBoards() {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    return render(
      <QueryClientProvider client={qc}>
        <RecycleBin projectId="p1" />
      </QueryClientProvider>,
    )
  }

  it('彻底删除看板失败：错误条给出原因与操作名，不静默', async () => {
    hoisted.deleted = {
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    }
    // 未归属看板查询：让分组出现
    vi.mocked(kanbanAPI.deletedBoards).mockResolvedValue({ boards } as never)
    vi.mocked(kanbanAPI.destroyDeletedBoard).mockRejectedValue(
      new Error('看板正在被使用，请稍后重试'),
    )

    renderTrashBoards()

    // 等待未归属看板分组渲染
    await waitFor(() => {
      expect(screen.getByTestId('remove-orphan-kanban-board-1')).toBeInTheDocument()
    })

    // 确认框点确定
    window.confirm = () => true
    fireEvent.click(screen.getByTestId('remove-orphan-kanban-board-1'))

    await waitFor(() => {
      expect(screen.getByTestId('restore-error')).toBeInTheDocument()
    })
    const bar = screen.getByTestId('restore-error')
    expect(bar.textContent).toContain('彻底删除看板失败')
    expect(bar.textContent).toContain('看板正在被使用，请稍后重试')
  })
})

/**
 * 回收站「彻底删除」的影响面计数。
 *
 * 缺陷：确认框一律用项目级 deletedList 建的索引算后代，而孤儿会话
 * （projectId=null，来自「未归属项目」分组）根本不在 deletedList 里，计数恒为 0。
 * 服务端 permanentlyDeleteSession 走 deleteSessionSubtrees(handle, [id])，
 * 连同全部后代（含未软删的 fork 后代）一起物理清除。于是逐字确认框明确写着
 * 「及其 0 个派生会话」，用户据此以为只删一条，实际整棵分支树不可恢复地没了。
 * 删除项目会把该项目全部会话（含 fork 子会话）软删成孤儿分组，恰是后代最易
 * 成树之处。
 */
describe('RecycleBin 彻底删除的影响面', () => {
  const orphanRoot = makeSession('orphan-root', '孤儿根会话', null)
  const orphanChild = {
    ...makeSession('orphan-child', '孤儿子会话', null),
    parentId: 'orphan-root',
  }
  const orphanGrandchild = {
    ...makeSession('orphan-grandchild', '孤儿孙会话', null),
    parentId: 'orphan-child',
  }

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

  it('孤儿根会话的确认框写出派生后代数（此前恒为 0）', async () => {
    hoisted.deleted = {
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    }
    hoisted.orphans = { data: [orphanRoot, orphanChild, orphanGrandchild] }
    hoisted.orphanCount = { data: { count: 3 } }

    renderTrash()
    fireEvent.click(screen.getByTestId('orphan-trash-toggle'))
    await waitFor(() => {
      expect(screen.getByTestId('remove-orphan-orphan-root')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('remove-orphan-orphan-root'))

    // 逐字确认框里必须写明真实影响面，而不是「及其 0 个派生会话」
    expect(screen.getByText(/及其 2 个派生会话/)).toBeInTheDocument()
  })

  it('项目内会话的计数照旧（同一套索引，两种分组各自取数）', async () => {
    const projectRoot = { ...makeSession('proj-root', '项目根会话'), deletedAt: 1 }
    const projectChild = {
      ...makeSession('proj-child', '项目子会话'),
      parentId: 'proj-root',
      deletedAt: 1,
    }
    hoisted.deleted = {
      data: [projectRoot, projectChild],
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    }
    hoisted.orphans = { data: [orphanRoot, orphanChild, orphanGrandchild] }
    hoisted.orphanCount = { data: { count: 3 } }

    renderTrash()
    await waitFor(() => {
      expect(screen.getByTestId('remove-forever-proj-root')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('remove-forever-proj-root'))

    expect(screen.getByText(/及其 1 个派生会话/)).toBeInTheDocument()
  })
})

/**
 * 回归：会话树里删除会话的确认框影响面必须按**未过滤**的完整树计算。
 *
 * 缺陷：handleDelete 用 findNode(visibleTree, id) 取节点，而 visibleTree 是
 * 搜索过滤后的视图（searchTree 只保留命中路径），「未归属项目」的 CLI 根又
 * 根本不进 visibleTree（filterTree 按根 projectId 过滤）。于是 countDescendants
 * 把服务端的整棵子树级联软删（softDeleteSession → deleteSessionSubtrees）
 * 少报成「0 个派生会话」——用户以为只删一条，实际连同全部分支一起进回收站。
 */
describe('SessionList 删除会话的影响面', () => {
  const P_ROOT = makeSession('p-root', '父任务')
  const F1 = { ...makeSession('f1', 'alpha 分支'), parentId: 'p-root' }
  const F2 = { ...makeSession('f2', 'unique 分支'), parentId: 'p-root' }
  const F3 = { ...makeSession('f3', 'gamma 分支'), parentId: 'p-root' }

  /** window.confirm 打桩，返回消息文本；用例结束恢复原实现。 */
  function stubConfirm(): { calls: string[]; restore: () => void } {
    const calls: string[] = []
    const orig = window.confirm
    window.confirm = ((msg?: string) => {
      calls.push(String(msg))
      return false
    }) as typeof window.confirm
    return { calls, restore: () => (window.confirm = orig) }
  }

  it('搜索过滤时仍写出真实的派生后代数（此前按过滤后的树算成 0）', () => {
    const confirm = stubConfirm()
    try {
      hoisted.tree = [node(P_ROOT, [node(F1), node(F2), node(F3)])]
      renderList()
      // 搜索只命中 f2 → 树里只剩「父任务 > unique 分支」这条路径
      fireEvent.change(screen.getByTestId('session-search'), { target: { value: 'unique' } })
      expect(screen.getByTestId('delete-p-root')).toBeInTheDocument()
      fireEvent.click(screen.getByTestId('delete-p-root'))
      expect(confirm.calls).toHaveLength(1)
      expect(confirm.calls[0]).toContain('其 3 个派生会话')
    } finally {
      confirm.restore()
    }
  })

  it('未归属项目的 CLI 会话删除也写出派生后代数（此前恒为 0）', () => {
    const confirm = stubConfirm()
    try {
      const cliRoot = { ...makeSession('cli-root', 'cli 父会话', null), source: 'cli' as const }
      const cliChild = {
        ...makeSession('cli-child', 'cli 子会话', null),
        source: 'cli' as const,
        parentId: 'cli-root',
      }
      hoisted.tree = [node(cliRoot, [node(cliChild)])]
      renderList()
      expect(screen.getByTestId('delete-cli-root')).toBeInTheDocument()
      fireEvent.click(screen.getByTestId('delete-cli-root'))
      expect(confirm.calls[0]).toContain('其 1 个派生会话')
    } finally {
      confirm.restore()
    }
  })
})
