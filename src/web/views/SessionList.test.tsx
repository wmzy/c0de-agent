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
import { draftStorageKey } from '@/composer/draft.js'
import { kanbanAPI } from '@/services/kanban.js'
import { sessionAPI } from '@/services/session.js'
import type { SessionTreeNode } from '@/types/index.js'
import { storageGet, storageSet } from '@/utils/storage.js'
import { RecycleBin } from '@/views/RecycleBin.js'
import { SessionList } from '@/views/SessionList.js'

const hoisted = vi.hoisted(() => ({
  tree: [] as unknown[],
  /** 项目列表查询的返回值（可整体替换以模拟读取失败）。 */
  projectsQuery: null as null | (() => { data?: unknown; isError?: boolean; error?: unknown }),
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
  /** 恢复 mutation：mutate 的调用次数与「在途」状态都由用例驱动（回收站按钮的在途锁）。 */
  restoreMut: { mutate: vi.fn(), isPending: false },
  /** 「未归属项目」分组的数据源：孤儿已删会话与其计数。 */
  orphans: { data: [] as Session[] } as {
    data: Session[] | undefined
    isLoading?: boolean
    isError?: boolean
    error?: unknown
    refetch?: () => void
  },
  /** 删除会话 mutation 的 mutate：默认 no-op；用例可赋实现以驱动 onSuccess/onError。 */
  deleteMutate: undefined as
    | ((id: string, opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }) => void)
    | undefined,
  /** 删除在途标记：isPending 是普通布尔字段（mock 不认），用例自行置位/复位。 */
  deleteMut: { isPending: false },
  /** 孤儿计数查询的完整返回值——驱动读失败分支与「重试」入口。 */
  orphanCount: {
    data: { count: 0 } as { count: number } | undefined,
  } as {
    data: { count: number } | undefined
    isError?: boolean
    error?: unknown
    refetch?: () => void
  },
}))

vi.mock('@/hooks/useSession.js', () => ({
  useSessionTree: () => {
    if (hoisted.treeQuery.isError) return hoisted.treeQuery
    return { ...hoisted.treeQuery, data: hoisted.tree }
  },
  useDeleteSession: () => ({
    mutate: (id: string, opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }) =>
      hoisted.deleteMutate?.(id, opts),
    isPending: hoisted.deleteMut.isPending,
  }),
  useProjects: () =>
    hoisted.projectsQuery
      ? hoisted.projectsQuery()
      : { data: [{ id: 'p1', name: 'proj', worktree: '/tmp/proj' }] },
  useDeletedSessions: () => hoisted.deleted,
  useDeletedOrphansCount: () => hoisted.orphanCount,
  useDeletedOrphans: () => hoisted.orphans,
  useRestoreSession: () => hoisted.restoreMut,
}))

vi.mock('@/services/session.js', () => ({
  sessionAPI: {
    search: vi.fn(),
    rename: vi.fn(),
    importSession: vi.fn(),
    touchOrphansSeen: vi.fn().mockResolvedValue({ ok: true, touched: 0 }),
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
  hoisted.deleteMutate = undefined
  hoisted.deleteMut.isPending = false
  // mutate 的调用计数会被 afterEach 的 clearAllMocks 清掉，但 isPending 是普通
  // 布尔字段（clearAllMocks 不碰它）——不清会让后续用例拿到一把永久上锁的恢复按钮。
  hoisted.restoreMut.isPending = false
  // 主列表默认健康：读失败态由各用例自行设置。hoisted 是普通对象（非 mock），
  // afterEach 的 clearAllMocks 不会还原它——不在这里重置，上一用例留下的
  // isError:true 会漏进下一个用例，让它渲染成错误页。
  hoisted.deleted = {
    data: [],
    isLoading: false,
    isError: false,
    error: null,
    refetch: () => {},
  }
  hoisted.orphanCount = {
    data: { count: 0 },
    isError: false,
    error: null,
    refetch: () => {},
  }
  hoisted.treeQuery = {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: () => {},
  }
  hoisted.projectsQuery = null
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

  /**
   * 回归：搜索时未绑定项目的 CLI 会话整组消失，还给出「无匹配会话」。
   *
   * 缺陷：unboundCliRoots 在 search.length > 0 时直接取 []。那组是 P1-2 专门为
   * 「CLI 会话在 Web 可达」加的，而 CLI 会话的 cwd 不属于任何已注册项目 →
   * 项目树按 projectId 过滤后没有它、内容搜索按 projectId 过滤也查不到它
   * （/api/sessions/search），标题匹配是它唯一的入口。于是输入该会话标题里的
   * 一个字，上一个按键还在屏幕上的那一行变成「无匹配会话」，用户再没有入口
   * 找回它（只能清空搜索框）。
   */
  it('搜索命中未绑定项目的 CLI 会话时仍然列出它，不报「无匹配会话」', async () => {
    vi.mocked(sessionAPI.search).mockResolvedValue({ results: [] })
    const cliHit = {
      ...makeSession('cli-hit', 'cli 迁移脚本', null),
      source: 'cli' as const,
    }
    const cliOther = {
      ...makeSession('cli-other', 'cli 无关会话', null),
      source: 'cli' as const,
    }
    hoisted.tree = [node(ROOT), node(cliHit), node(cliOther)]
    renderList()

    fireEvent.change(screen.getByTestId('session-search'), { target: { value: '迁移' } })

    await waitFor(() => {
      expect(screen.getByTestId('node-cli-hit')).toBeInTheDocument()
    })
    // 不命中的那一条仍然按搜索过滤掉
    expect(screen.queryByTestId('node-cli-other')).toBeNull()
    expect(screen.queryByText('无匹配会话')).toBeNull()
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
 * 回归：一次重命名失败后，红条会永远挂在侧栏顶部。
 *
 * renameError 只在失败时写入，成功分支不清空、清空点只有切项目。于是网络抖动
 * 造成的一次失败之后，用户改好网络再成功改名——红字仍在，他要么以为改名功能
 * 一直坏着，要么怀疑刚才那次「成功」其实没生效（同页的删除失败条会在下一次
 * 删除时自清，行为还不一致）。
 */
describe('SessionList 重命名失败原因', () => {
  async function renameTo(newTitle: string): Promise<void> {
    fireEvent.click(screen.getByTestId('rename-root-id'))
    const form = await screen.findByTestId('rename-form-root-id')
    fireEvent.change(screen.getByLabelText('重命名会话 hit-root'), { target: { value: newTitle } })
    fireEvent.submit(form)
  }

  it('下一次重命名（无论成败）先清掉旧原因，不再常驻假失败', async () => {
    vi.mocked(sessionAPI.rename)
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce({ ok: true, title: '改名成功' } as never)
    renderList()
    await waitFor(() => expect(screen.getByTestId('node-root-id')).toBeInTheDocument())

    await renameTo('第一次改名')
    await waitFor(() => {
      expect(screen.getByTestId('rename-error')).toHaveTextContent('重命名失败：网络中断')
    })

    // 网络恢复后再改一次名（这次成功）→ 旧的失败原因必须消失
    await renameTo('第二次改名成功')
    await waitFor(() => {
      expect(screen.queryByTestId('rename-error')).toBeNull()
    })
    expect(sessionAPI.rename).toHaveBeenLastCalledWith('root-id', '第二次改名成功')
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

  /**
   * 回归：孤儿（未归属项目）会话计数读失败被 `?? 0` 吃成「没有孤儿」。
   *
   * 缺陷：`(orphanCountData?.count ?? 0) > 0` 是整组的唯一渲染条件。计数请求
   * 失败时 data 为 undefined → 表头、「展开」按钮与全部恢复/彻底删除入口整块
   * 消失，页面零文字。孤儿是删除项目产生的，只有这个分组能看见与恢复，读不到
   * 却当成没有，条目会按保留期被静默清除。对照：主列表同页已有 trash-load-error。
   */
  it('未归属项目会话计数读失败：给原因与重试，不把整组吃掉', () => {
    const refetch = vi.fn()
    hoisted.orphanCount = {
      data: undefined,
      isError: true,
      error: { status: 500, message: '孤儿计数炸了' },
      refetch,
    }
    renderTrash()
    const bar = screen.getByTestId('orphan-count-error')
    expect(bar.textContent).toContain('未归属项目会话读取失败')
    expect(bar.textContent).toContain('孤儿计数炸了')
    // 读不到 ≠ 没有：表头不能凭空缺席到让人以为「没有孤儿」
    expect(screen.queryByTestId('orphan-trash-header')).toBeNull()
    fireEvent.click(screen.getByTestId('orphan-count-retry'))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  /**
   * 回归：未归属看板列表读失败被 `?? []` 吃成「没有未归属看板」——合并到当前
   * 项目 / 恢复并重建原项目 / 彻底删除三个入口随之静默消失。
   */
  it('未归属看板读失败：给原因与重试，不静默消失', async () => {
    vi.mocked(kanbanAPI.deletedBoards).mockRejectedValueOnce(new Error('看板炸了'))
    renderTrash()
    await waitFor(() => {
      expect(screen.getByTestId('orphan-kanban-error')).toBeInTheDocument()
    })
    const bar = screen.getByTestId('orphan-kanban-error')
    expect(bar.textContent).toContain('未归属看板读取失败')
    expect(bar.textContent).toContain('看板炸了')
    expect(screen.queryByTestId('orphan-kanban-header')).toBeNull()
    expect(screen.getByTestId('orphan-kanban-retry')).toBeInTheDocument()
  })

  /**
   * 回归：孤儿列表读失败被 `orphans ?? []` 吃成空分组——表头写着「N 条」，展开
   * 后一行都没有、零文字、零重试；更糟的是展开那一刻无条件 touchOrphansSeen，
   * 把这些用户从未看到的条目在服务端标成「已看到」，启动 60 天保留倒计时。
   */
  it('未归属项目会话列表读失败：给原因与重试，且不启动保留倒计时', () => {
    const refetch = vi.fn()
    hoisted.orphanCount = { data: { count: 3 }, isError: false, error: null, refetch: vi.fn() }
    hoisted.orphans = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 500, message: '孤儿列表炸了' },
      refetch,
    }
    renderTrash()
    fireEvent.click(screen.getByTestId('orphan-trash-toggle'))
    const bar = screen.getByTestId('orphan-list-error')
    expect(bar.textContent).toContain('孤儿列表炸了')
    expect(screen.queryByTestId('orphan-list-loading')).toBeNull()
    fireEvent.click(screen.getByTestId('orphan-list-retry'))
    expect(refetch).toHaveBeenCalledTimes(1)
    // 列表没拿到就绝不能标记「已看到」（否则倒计时先于用户看到条目启动）
    expect(vi.mocked(sessionAPI.touchOrphansSeen)).not.toHaveBeenCalled()
  })

  it('未归属项目会话列表拿到后标记「已看到」启动保留期', () => {
    hoisted.orphanCount = { data: { count: 1 }, isError: false, error: null, refetch: vi.fn() }
    hoisted.orphans = { data: [makeSession('orphan-1', '孤儿', null)] }
    renderTrash()
    fireEvent.click(screen.getByTestId('orphan-trash-toggle'))
    expect(screen.getByTestId('orphan-orphan-1')).toBeInTheDocument()
    expect(vi.mocked(sessionAPI.touchOrphansSeen)).toHaveBeenCalledTimes(1)
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

  // 会话树读失败时不得把回收站渲染到「列表加载失败」横幅下方：回收站开关仍是
  // 未按下的 aria-pressed="false"，面板内容却变成已删除会话行，且「清空回收站 /
  // 彻底删除」这些破坏性按钮就在一个自称加载失败的面板里可点。刚删过会话的用户
  // 会以为删除失败或会话复活。旧实现的分支是 `!showRecycle && !isError ? 树 : 回收站`。
  it('读失败且未切到回收站时，不得把回收站渲染出来', () => {
    hoisted.treeQuery = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 500, message: 'boom' },
      refetch: () => {},
    }
    renderList()

    expect(screen.getByTestId('sessions-load-error')).toBeInTheDocument()
    expect(screen.queryByTestId('trash-empty')).toBeNull()
    expect(screen.queryByText('清空回收站')).toBeNull()

    // 控件校验：切到回收站后它才出现——证明上面的缺席是「分支没进」，不是回收站本就渲染不出。
    fireEvent.click(screen.getByTestId('recycle-toggle'))
    expect(screen.getByTestId('trash-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('sessions-load-error')).toBeNull()
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
    expect(screen.queryByText(/没有匹配/)).toBeNull()
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

  it('真的没有匹配时才说「没有匹配」，且口径限定在本项目', async () => {
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
      expect(screen.getByText(/本项目回收站内没有匹配「不存在的词」的会话/)).toBeInTheDocument()
    })
    expect(screen.queryByTestId('trash-search-error')).toBeNull()
  })

  // 回归：恢复不是幂等的（服务端对「未处于已删除状态」的会话一律回 404
  // 「会话不存在或未删除」）。慢网下连点两次会发出两次 POST，第二次必撞 404，
  // 页面于是在会话已经回到列表的同时挂着红色「恢复失败」。
  it('恢复在途禁用：连点两次只发一次请求', async () => {
    hoisted.deleted = {
      data: [makeSession('old-id', '旧会话')],
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    }
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const ui = (
      <QueryClientProvider client={qc}>
        <RecycleBin projectId="p1" />
      </QueryClientProvider>
    )
    const { rerender } = render(ui)
    const btn = await screen.findByTestId('restore-old-id')

    // 请求在途：把 isPending 置真后重渲染（真实实现由 react-query 触发）
    hoisted.restoreMut.mutate.mockImplementation(() => {
      hoisted.restoreMut.isPending = true
    })
    fireEvent.click(btn)
    expect(hoisted.restoreMut.mutate).toHaveBeenCalledTimes(1)
    rerender(ui)

    await waitFor(() => expect(screen.getByTestId('restore-old-id')).toBeDisabled())
    // 连点第二下：按钮已锁，不会再发第二次 POST
    fireEvent.click(screen.getByTestId('restore-old-id'))
    expect(hoisted.restoreMut.mutate).toHaveBeenCalledTimes(1)
  })
})

/**
 * 「回收站为空」与「搜不到」都必须覆盖整页的三组数据。
 *
 * 缺陷一：空态只判 deletedList.length === 0，于是删除一个项目后打开**另一个**
 * 项目的回收站（孤儿出现的标准场景），屏幕上方写着「回收站为空」、紧下方列着
 * 「未归属项目（N 条）」与恢复按钮——用户照空态结论离开，那些会话按保留期被
 * 静默清除。
 *
 * 缺陷二：搜索框与「回收站无匹配会话」都包在 deletedList.length > 0 里，且
 * 服务端搜索带 projectId、只覆盖本项目条目——项目条目为空时连搜索框都没有，
 * 搜一条明摆在下方的孤儿标题得不到任何结果。
 */
describe('RecycleBin 未归属项目分组的空态与搜索口径', () => {
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

  it('本项目无条目但有未归属会话时不说「回收站为空」', () => {
    hoisted.deleted = {
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    }
    hoisted.orphanCount = {
      data: { count: 2 },
      isError: false,
      error: null,
      refetch: () => {},
    }
    renderTrash()

    expect(screen.queryByTestId('trash-empty')).toBeNull()
    expect(screen.getByTestId('trash-project-empty')).toHaveTextContent('本项目回收站为空')
    expect(screen.getByTestId('trash-project-empty')).toHaveTextContent('2 条会话在下方')
    expect(screen.getByTestId('orphan-trash-header')).toBeInTheDocument()
  })

  it('三组数据都为空时才是「回收站为空」', () => {
    renderTrash()
    expect(screen.getByTestId('trash-empty')).toHaveTextContent('回收站为空')
    expect(screen.queryByTestId('trash-project-empty')).toBeNull()
  })

  it('未归属计数读不到时不谎称回收站为空', () => {
    hoisted.orphanCount = {
      data: undefined,
      isError: true,
      error: new Error('孤儿计数后端炸了'),
      refetch: () => {},
    }
    renderTrash()

    expect(screen.queryByTestId('trash-empty')).toBeNull()
    expect(screen.getByTestId('orphan-count-error')).toHaveTextContent('孤儿计数后端炸了')
  })

  it('本项目无条目时搜索框仍然在，并说清未归属分组不在搜索范围内', async () => {
    hoisted.deleted = {
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    }
    hoisted.orphanCount = {
      data: { count: 1 },
      isError: false,
      error: null,
      refetch: () => {},
    }
    renderTrash()

    expect(screen.getByTestId('trash-search')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('trash-search'), { target: { value: '孤儿标题' } })
    // 搜索词有 300ms 防抖
    await waitFor(() => expect(screen.getByTestId('orphan-search-hint')).toBeInTheDocument(), {
      timeout: 2000,
    })
    expect(screen.getByTestId('orphan-search-hint')).toHaveTextContent('未归属项目')
  })

  it('展开未归属分组后，搜索词在组内按标题过滤', async () => {
    hoisted.deleted = {
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    }
    hoisted.orphanCount = {
      data: { count: 2 },
      isError: false,
      error: null,
      refetch: () => {},
    }
    hoisted.orphans = {
      data: [
        makeSession('orph-1', '未归属会话甲', null),
        makeSession('orph-2', '未归属会话乙', null),
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    }
    vi.mocked(sessionAPI.search).mockResolvedValue({ results: [] })
    renderTrash()

    fireEvent.click(screen.getByTestId('orphan-trash-toggle'))
    expect(screen.getByTestId('orphan-orph-1')).toBeInTheDocument()
    expect(screen.getByTestId('orphan-orph-2')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('trash-search'), { target: { value: '乙' } })
    await waitFor(() => {
      expect(screen.queryByTestId('orphan-orph-1')).toBeNull()
    })
    expect(screen.getByTestId('orphan-orph-2')).toBeInTheDocument()
    // 命中为零时要说清是组内没有匹配，不复用项目列表的「无匹配会话」
    fireEvent.change(screen.getByTestId('trash-search'), { target: { value: '不存在的词' } })
    await waitFor(() => {
      expect(screen.getByTestId('orphan-search-empty')).toHaveTextContent('不存在的词')
    })
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

  it('彻底删除看板先逐字确认，失败原因不静默且不误用原生 confirm', async () => {
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

    // 点「彻底删除」只打开站内逐字确认弹层，绝不触发原生 window.confirm
    // （原生框默认键=确定，回车即毁板）。逐字确认前接口不得被调用、确认键禁用。
    const confirmSpy = vi.fn(() => true)
    const origConfirm = window.confirm
    window.confirm = confirmSpy as unknown as typeof window.confirm
    try {
      fireEvent.click(screen.getByTestId('remove-orphan-kanban-board-1'))
      const confirmBtn = (await screen.findByTestId('danger-confirm-btn')) as HTMLButtonElement
      expect(confirmBtn.disabled).toBe(true)
      expect(kanbanAPI.destroyDeletedBoard).not.toHaveBeenCalled()
      expect(confirmSpy).not.toHaveBeenCalled()

      // 输入看板所属项目名后确认键才可用
      fireEvent.change(screen.getByTestId('danger-confirm-input'), {
        target: { value: '已删项目' },
      })
      expect(confirmBtn.disabled).toBe(false)
      fireEvent.click(confirmBtn)
    } finally {
      window.confirm = origConfirm
    }

    // 失败原因留在页面错误条里，不静默
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

  /** window.confirm 打桩：删除确认已改为站内弹窗，任何路径都不该再碰原生框。 */
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
      // 站内弹窗（不再有原生 confirm）
      expect(confirm.calls).toHaveLength(0)
      expect(screen.getByTestId('delete-session-detail').textContent).toContain('其 3 个派生会话')
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
      expect(confirm.calls).toHaveLength(0)
      expect(screen.getByTestId('delete-session-detail').textContent).toContain('其 1 个派生会话')
    } finally {
      confirm.restore()
    }
  })

  // 回归：删除不是幂等的（服务端对「已在回收站」的会话一律回 404 NOT_FOUND）。
  // 慢网下连点两下会发出两次 DELETE，第二次必撞 404：会话已经进了回收站，页面却
  // 挂着一条常驻的「删除失败」红条，与事实正好相反。行内删除键在在途期间必须禁用，
  // handleDelete 还要再挡一次（disabled 只拦点击，不拦同 tick 的事件重入）。
  it('删除在途禁用：连点两次只发一次请求', () => {
    const sent: string[] = []
    hoisted.deleteMutate = (id) => {
      sent.push(id)
      // 真实实现里 react-query 在 mutate 后立即置 isPending
      hoisted.deleteMut.isPending = true
    }
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    // 每次都造新的元素对象：复用同一 element 时 React 会跳过重渲染，
    // 在途状态就读不到（restoreMut 那条用例能过是因为它的 pending 来自组件内 state）。
    const ui = () => (
      <QueryClientProvider client={qc}>
        <SessionList projectId="p1" activeId={null} onSelect={vi.fn()} onNewSession={vi.fn()} />
      </QueryClientProvider>
    )
    const { rerender } = render(ui())
    // 行内删除键只打开站内确认弹窗，不发请求
    fireEvent.click(screen.getByTestId('delete-root-id'))
    expect(sent).toEqual([])
    fireEvent.click(screen.getByTestId('delete-session-confirm'))
    expect(sent).toEqual(['root-id'])

    // 在途：重渲染后确认键置灰，且再点一次不会发出第二个 DELETE
    rerender(ui())
    const btn = screen.getByTestId('delete-session-confirm')
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(sent).toEqual(['root-id'])
    expect(screen.queryByTestId('delete-error')).toBeNull()
  })

  // 回归（审查 #7）：侧栏删除会话成功后，s:<id> 草稿键不得滞留 localStorage
  // （文本无上限、图片最多 ~512KB），否则被删会话的草稿永久堆积。
  it('删除成功后清退该会话的草稿键，不动其他作用域', () => {
    try {
      storageSet(
        draftStorageKey('s:root-id'),
        JSON.stringify({
          prompt: [{ type: 'text', start: 0, end: 2, content: '未发送的草稿' }],
          images: [],
        }),
      )
      storageSet(
        draftStorageKey('p:p1'),
        JSON.stringify({
          prompt: [{ type: 'text', start: 0, end: 4, content: '草稿页的项目草稿' }],
          images: [],
        }),
      )
      hoisted.deleteMutate = (id, opts) => {
        expect(id).toBe('root-id')
        opts?.onSuccess?.()
      }
      renderList()
      fireEvent.click(screen.getByTestId('delete-root-id'))
      fireEvent.click(screen.getByTestId('delete-session-confirm'))

      expect(storageGet(draftStorageKey('s:root-id'))).toBeNull()
      // 其他作用域（项目草稿页）不受影响
      expect(storageGet(draftStorageKey('p:p1'))).not.toBeNull()
    } finally {
      localStorage.removeItem(draftStorageKey('s:root-id'))
      localStorage.removeItem(draftStorageKey('p:p1'))
    }
  })
})

/**
 * 导入会话时权限态迁移此前走 window.confirm：原生框的默认键是「确定」=
 * 随迁权限（auto 模式 / alwaysAllow 白名单，工具此后免确认执行），回车直达
 * 危险侧，而「取消」才是推荐的安全侧。同仓的导出快照选择（bb056bf）早已改成
 * 站内弹窗，这条路径漏了。
 *
 * 站内弹窗里危险动作是**默认未勾选**的复选框：初始焦点落在它上面，回车既不会
 * 迁移权限，也不会把弹窗关掉（原生框的 Enter 恰好相反）。
 */
describe('SessionList 导入会话的权限态确认', () => {
  /** 带权限态的导出文件：auto 模式 + 一个白名单工具。 */
  const withPermissions = {
    version: 1,
    session: {
      title: '带权限的会话',
      metadata: { permissionMode: 'auto', alwaysAllow: ['bash'] },
    },
    messages: [],
  }

  function importFile(payload: unknown) {
    const file = { text: () => Promise.resolve(JSON.stringify(payload)) } as unknown as File
    const input = screen.getByTestId('session-import-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })
  }

  it('含权限态时改用站内弹窗，不再弹原生 confirm；未确认前不导入', async () => {
    const confirmSpy = vi.fn(() => true)
    const orig = window.confirm
    window.confirm = confirmSpy as unknown as typeof window.confirm
    try {
      renderList()
      importFile(withPermissions)

      await waitFor(() =>
        expect(screen.getByTestId('import-permissions-dialog')).toBeInTheDocument(),
      )
      expect(confirmSpy).not.toHaveBeenCalled()
      expect(vi.mocked(sessionAPI.importSession)).not.toHaveBeenCalled()
      expect(screen.getByTestId('import-permissions-detail').textContent).toContain(
        '自动授权模式（auto）',
      )
      // 危险动作默认关闭，且初始焦点就在这个复选框上（不是「随迁」按钮）
      expect((screen.getByTestId('import-permissions-migrate') as HTMLInputElement).checked).toBe(
        false,
      )
      expect(document.activeElement).toBe(screen.getByTestId('import-permissions-migrate'))
    } finally {
      window.confirm = orig
    }
  })

  it('不勾选即继续导入 → 权限不随迁（默认安全侧）', async () => {
    renderList()
    importFile(withPermissions)
    await waitFor(() => expect(screen.getByTestId('import-permissions-dialog')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('import-permissions-continue'))
    await waitFor(() => expect(vi.mocked(sessionAPI.importSession)).toHaveBeenCalled())
    expect(vi.mocked(sessionAPI.importSession).mock.calls[0]?.[2]).toEqual({
      importPermissions: false,
    })
  })

  it('显式勾选后继续导入 → 权限随迁', async () => {
    renderList()
    importFile(withPermissions)
    await waitFor(() => expect(screen.getByTestId('import-permissions-dialog')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('import-permissions-migrate'))
    fireEvent.click(screen.getByTestId('import-permissions-continue'))
    await waitFor(() => expect(vi.mocked(sessionAPI.importSession)).toHaveBeenCalled())
    expect(vi.mocked(sessionAPI.importSession).mock.calls[0]?.[2]).toEqual({
      importPermissions: true,
    })
  })

  it('不含权限态的导出文件直接导入，不打扰用户', async () => {
    renderList()
    importFile({ version: 1, session: { title: '干净会话', metadata: {} }, messages: [] })

    await waitFor(() => expect(vi.mocked(sessionAPI.importSession)).toHaveBeenCalled())
    expect(screen.queryByTestId('import-permissions-dialog')).toBeNull()
    expect(vi.mocked(sessionAPI.importSession).mock.calls[0]?.[2]).toEqual({
      importPermissions: false,
    })
  })
})

/**
 * 导入的「选择目标项目」门禁（P1-2）依赖项目列表来判断导出会话的原归属。
 * 列表读不到时 `(projects ?? [])` 恒为空 → original 恒 undefined →
 * continueImport 直接把会话绑到当前项目，那道门整个不出现、零错误提示：
 * 真实浏览器注入 500 后，导出自 projB 的会话静默落到 projA，
 * 继续对话时 bash/git 全跑在 projA 的 worktree 里。
 */
describe('SessionList 导入时项目列表读不到', () => {
  const fromOtherProject = {
    version: 1,
    session: { title: '来自 B 的会话', projectId: 'p2', worktreePath: '/tmp/projB' },
    messages: [],
  }

  function importFile(payload: unknown) {
    const file = { text: () => Promise.resolve(JSON.stringify(payload)) } as unknown as File
    const input = screen.getByTestId('session-import-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })
  }

  beforeEach(() => {
    vi.mocked(sessionAPI.importSession).mockResolvedValue({
      sessionId: 'imported-s1',
      flattened: false,
      permissionsMigrated: false,
    } as never)
  })

  it('中止导入并给出真实原因，不把会话静默绑到当前项目', async () => {
    hoisted.projectsQuery = () => ({
      data: undefined,
      isError: true,
      error: new Error('项目列表读取失败'),
    })
    renderList()
    importFile(fromOtherProject)

    await waitFor(() => expect(screen.getByTestId('import-error')).toBeInTheDocument())
    expect(screen.getByTestId('import-error').textContent).toContain('项目列表读取失败')
    expect(vi.mocked(sessionAPI.importSession)).not.toHaveBeenCalled()
    expect(screen.queryByTestId('import-target-dialog')).toBeNull()
  })

  it('导出文件不带原项目归属时照常导入（没有可匹配的目标，不该拦）', async () => {
    hoisted.projectsQuery = () => ({
      data: undefined,
      isError: true,
      error: new Error('项目列表读取失败'),
    })
    renderList()
    importFile({ version: 1, session: { title: '匿名会话', metadata: {} }, messages: [] })

    await waitFor(() => expect(vi.mocked(sessionAPI.importSession)).toHaveBeenCalled())
    expect(screen.queryByTestId('import-error')).toBeNull()
  })
})
