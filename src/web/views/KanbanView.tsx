import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { css } from '@linaria/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ChangeEvent, useCallback, useRef, useState } from 'react'
import { BoardConfigDialog } from '@/components/kanban/BoardConfigDialog.js'
import { CardEditDialog } from '@/components/kanban/CardEditDialog.js'
import { computeDropPosition } from '@/components/kanban/drop-position.js'
import { KanbanColumn } from '@/components/kanban/KanbanColumn.js'
import { type KanbanCard, kanbanAPI } from '@/services/kanban.js'

const view = css`
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
`

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid var(--haze-color-border);
  flex-shrink: 0;
`

const headerTitle = css`
  font-size: 15px;
  font-weight: 600;
`

/** 看板定位说明：项目级 vs 会话内待办的边界（产品定位，P2）。 */
const headerHint = css`
  flex: 1;
  margin-left: 12px;
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const configBtn = css`
  min-height: auto;
  min-width: auto;
  padding: 4px 12px;
  font-size: 12px;
`

/**
 * 看板列横向滚动容器。
 *
 * `tabindex="0"` + role/aria-label 是键盘可达性的关键，不是可选装饰：
 * 列宽固定 280px（KanbanColumn 的 width/min-width），5 列 + 4 个 12px 间距
 * + 24px 内边距 = 1472px。窄于此的视口都会溢出——实测 1280px 溢出 192px、
 * 1440px 溢出 20px、390px 手机上溢出 1082px。列数随用户「看板设置」增删，
 * 溢出量还会随自定义列数继续放大。
 *
 * 原先容器不可聚焦，浏览器不会为它做滚动对齐：Tab 把焦点送进第 5 列的
 * 「+ 新建卡片」按钮后，该按钮实测落在 right=1453（1280px 视口外 173px），
 * 而 boardArea.scrollLeft 恒为 0——键盘用户聚焦了一个完全看不见的控件，
 * 读屏用户听到「新建卡片」却不知它在屏幕外。聚焦容器使其成为滚动祖先，
 * 浏览器默认的「聚焦即滚入视口」才能生效。
 *
 * 焦点环用 :focus-visible：鼠标点容器不显示描边，键盘 Tab 过去才显示。
 * outline-offset: -2px 让描边画在容器内缘，不被 overflow 裁掉。
 */
const boardArea = css`
  display: flex;
  gap: 12px;
  padding: 12px;
  overflow-x: auto;
  overflow-y: hidden;
  flex: 1;
  min-height: 0;
  &:focus-visible {
    outline: 2px solid var(--haze-color-primary);
    outline-offset: -2px;
  }
`

/**
 * 溢出提示：仅在看板横向装不下时出现的一条说明。
 *
 * 5 列固定 280px 宽 = 1472px 底线，1280px 及以下视口必然溢出。原先除了
 * 一条会自动隐没的系统滚动条外没有任何提示：手机（390px）上系统滚动条
 * 通常整体隐藏，用户看到的是「已取消」列被齐腰切断，看不出右边还有内容，
 * 也就不知道可以横滑。
 *
 * 用 JS 测量 scrollWidth > clientWidth 后才渲染——纯 CSS 表达不了
 * 「内容溢出且我处在滚动起点」，这两者都只有实尺才知道。
 */
const scrollHint = css`
  flex-shrink: 0;
  padding: 6px 16px 0;
  color: var(--haze-color-text-secondary);
  font-size: 12px;
`

const loading = css`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--haze-color-text-secondary);
  font-size: 14px;
`

/**
 * 读失败态：标题 + 原因 + 自救入口三段式。
 *
 * 旧样式是一行 danger 色纯文本居中占满高度，连标题都塞在同一行里，
 * 读不出「哪坏了 / 为什么 / 怎么办」。这里拆开成竖排并给原因单独一档
 * 次级色：标题是语义（danger），原因是事实（text-secondary），
 * 重试是动作。role=alert 让读屏在失败发生时立刻播报，而不是等用户
 * 主动去浏览到这块区域。
 */
const errorState = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  padding: 16px;
  text-align: center;
`

const errorTitle = css`
  color: var(--haze-color-danger);
  font-size: 14px;
  font-weight: 600;
`

const errorDetail = css`
  max-width: 460px;
  color: var(--haze-color-text-secondary);
  font-size: 13px;
  /* 后端 message 可能是长路径/长句子，窄屏下必须能断行而不是撑出横向滚动 */
  overflow-wrap: anywhere;
`

const retryBtn = css`
  margin-top: 4px;
  padding: 6px 16px;
  font-size: 13px;
`

/** 导入/导出的行内错误条（看板已加载时的局部失败，与整页读失败态区分）。 */
const ioErrorBar = css`
  padding: 6px 12px;
  color: var(--haze-color-danger);
  font-size: 12px;
  overflow-wrap: anywhere;
`

type KanbanViewProps = {
  projectId: string
}

/**
 * 观察横向溢出：内容宽度是否超过容器可见宽度。
 *
 * 返回回调 ref 而非 ref 对象：看板容器在 query 落地前并不存在（加载中/失败态
 * 走的是提前 return 的另一棵树），useEffect([]) 在那之前就跑完，ref.current
 * 为 null 且没有 deps 可等它重来。回调 ref 在节点挂载的那一刻接管，之后由
 * 观察器接管后续变化。
 *
 * 两个触发源都会改变答案，缺一不可：
 * - 容器宽度：窗口缩放。这不触发任何 React 重渲染，只有 ResizeObserver 拦得住。
 * - 内容宽度：列的增删（query 数据到位、「看板设置」改列）。新增的子节点不会被
 *   已有的 ResizeObserver 接管，用 MutationObserver 补上增删的观测。
 *
 * 回退到 1px 容差：亚像素的 flex 舍入会让 scrollWidth 比 clientWidth 大零点几，
 * 那不是可滚动内容，不该弹提示。
 */
function useOverflowX() {
  const [overflowing, setOverflowing] = useState(false)
  const teardownRef = useRef<(() => void) | null>(null)

  const ref = useCallback((el: HTMLElement | null) => {
    teardownRef.current?.()
    teardownRef.current = null
    if (!el) return

    const measure = () => setOverflowing(el.scrollWidth - el.clientWidth > 1)

    const resizeObserver = new ResizeObserver(measure)
    const watchChildren = () => {
      for (const child of el.children) resizeObserver.observe(child)
    }
    watchChildren()
    measure()

    const mutationObserver = new MutationObserver(() => {
      watchChildren()
      measure()
    })
    mutationObserver.observe(el, { childList: true })

    teardownRef.current = () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [])

  return { ref, overflowing }
}

/**
 * 焦点进入某列时把该列横向滚入视口。
 *
 * 依赖浏览器默认的「聚焦即滚入视口」在此不成立，已实测：即使容器带 tabIndex=0，
 * 1280px 下 Tab 到第 5 列的「+ 新建卡片」后 boardArea.scrollLeft 仍为 0，
 * 按钮落在 right=1453（视口外 173px）。容器同时声明 overflow-y:hidden，
 * Chromium 的顺序焦点滚动只沿「在该轴可滚动」的祖先链上溯，x 轴可滚的祖先
 * 仍要经过这个 y 轴被禁用的节点，行为不可依赖。自己算，不赌引擎。
 *
 * 用 scrollIntoView 的 block:'nearest' + inline:'nearest'：只做最小位移，
 * 已经可见的列不会因为被聚焦而横向跳动。仅在焦点目标位于容器内部时处理，
 * 避免外层页面的焦点事件也来搅动看板。
 */
function handleBoardFocus(e: React.FocusEvent<HTMLDivElement>) {
  const board = e.currentTarget
  const target = e.target
  if (!(target instanceof HTMLElement) || !board.contains(target)) return
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

/** 看板主视图：加载 board、管理 DndContext 拖拽、卡片编辑/配置弹窗。 */
export function KanbanView({ projectId }: KanbanViewProps) {
  const qc = useQueryClient()
  const [editingCard, setEditingCard] = useState<KanbanCard | null>(null)
  const [showConfig, setShowConfig] = useState(false)
  const [ioError, setIoError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const {
    data: board,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['kanban', projectId],
    queryFn: () => kanbanAPI.get(projectId),
  })

  const { ref: boardRef, overflowing } = useOverflowX()

  // 卡片移动（乐观更新通过 invalidate 实现）
  const moveMutation = useMutation({
    mutationFn: ({
      cardId,
      columnId,
      position,
    }: {
      cardId: string
      columnId: string
      position?: number
    }) => kanbanAPI.updateCard(projectId, cardId, { columnId, position }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kanban', projectId] }),
  })

  // 快速新建卡片
  const addMutation = useMutation({
    mutationFn: ({ title, columnId }: { title: string; columnId: string }) =>
      kanbanAPI.addCard(projectId, { title, columnId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kanban', projectId] }),
  })

  // ── DnD handlers ────────────────────────────────────────

  /**
   * dragover: 当卡片拖到不同列上方（还未释放）时，实时预览移动。
   * 这样即使最后 drop 到空白列区域也能正确落位。
   */
  const handleDragOver = (_e: DragOverEvent) => {
    // 仅在 dragEnd 时提交，这里不做乐观更新避免频繁 mutation
  }

  /**
   * dragEnd: 根据释放位置计算目标 columnId 和 position。
   * dnd-kit 的 over.id 可能是另一个卡片（落到其槽位）或一个列（空白区）。
   * 落位计算走 drop-position.ts 的纯函数——与拖拽预览（verticalListSortingStrategy）
   * 同语义：落点顺序必须等于松手前用户看到的顺序。
   */
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return

    if (!board) return
    const activeCard = board.cards.find((c) => c.id === active.id)
    if (!activeCard) return

    // over.id 可能是卡片 id 或列 id
    const overId = String(over.id)
    const overCard = board.cards.find((c) => c.id === overId)
    const targetColumnId = overCard ? overCard.columnId : overId

    // 落在卡片上 → 按目标列卡片（position 升序）算落位；落在列空白 → position
    // 省略，由服务端追加到列尾。
    let position: number | undefined
    if (overCard) {
      const columnCards = board.cards
        .filter((c) => c.columnId === overCard.columnId)
        .sort((a, b) => a.position - b.position)
      const dropPosition = computeDropPosition(columnCards, activeCard.id, overCard.id)
      if (dropPosition === null) return // 落点与当前位置等价：无位移
      position = dropPosition
    }

    moveMutation.mutate({ cardId: activeCard.id, columnId: targetColumnId, position })
  }

  /** 导出整板为 JSON 文件（项目删除会永久级联删除看板——导出是唯一备份途径）。 */
  const handleExport = async () => {
    setIoError(null)
    try {
      const data = await kanbanAPI.exportBoard(projectId)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `kanban-${projectId}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setIoError(err instanceof Error ? err.message : '导出失败')
    }
  }

  /** 导入整板：替换当前列+标签+卡片。fail-closed 确认（不可撤销），
   *  明示「当前板将被覆盖」——防用户拿着旧备份导入后丢失新增卡片。 */
  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setIoError(null)
    try {
      const data = JSON.parse(await file.text()) as unknown
      const cards = (data as { cards?: unknown }).cards
      const cardCount = Array.isArray(cards) ? cards.length : 0
      const currentCount = board?.cards.length ?? 0
      if (
        !window.confirm(
          `导入将替换当前看板的列、标签与全部卡片：现有 ${currentCount} 张卡片将被覆盖` +
            `（导入 ${cardCount} 张卡片），且不可撤销。确定继续？`,
        )
      ) {
        return
      }
      const result = await kanbanAPI.importBoard(projectId, data)
      await qc.invalidateQueries({ queryKey: ['kanban', projectId] })
      setIoError(null)
      // 静默成功即可：看板即时刷新可见
      void result
    } catch (err) {
      setIoError(err instanceof Error ? err.message : '导入失败')
    }
  }

  if (isLoading) {
    return (
      <div className={view}>
        <div className={loading}>加载看板…</div>
      </div>
    )
  }

  // 读失败必须可自救。此前这里是一行纯文本「看板加载失败」：没有原因、
  // 没有重试入口，用户只能手动刷新整个页面；更要命的是它和 RecycleBin
  // 之前的空态一样，把「拉不到」说成了「没有」——而看板恰恰是用户手动
  // 维护的数据源，误判成空会让人以为卡片丢了。
  // 实测注入 /api/kanban 500、retry(2) 耗尽后：页面稳定停在
  // 「看板加载失败」，全页仅 8 个按钮、无任何「重试」，error message 被丢弃。
  // 与 RecycleBin 读失败态对齐：展示后端 message（APIError 是结构体而非
  // Error 子类，必须结构化取 message，否则渲染成 [object Object]）+ 重试按钮。
  if (isError || !board) {
    const message =
      (error as { message?: string } | null)?.message ??
      (error instanceof Error ? error.message : null)
    return (
      <div className={view}>
        <div className={errorState} data-testid="kanban-load-error" role="alert">
          <span className={errorTitle}>看板加载失败</span>
          <span className={errorDetail}>{message ?? '无法读取看板数据。'}</span>
          <button
            type="button"
            className={retryBtn}
            onClick={() => refetch()}
            data-testid="kanban-retry"
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={view} data-testid="kanban-view">
      <div className={header}>
        <span className={headerTitle}>📋 看板</span>
        <span
          className={headerHint}
          title="项目级任务看板，与聊天页的 agent 待办（TodoPanel）相互独立：看板由你手动维护，也可让 agent 用 kanban 工具操作"
        >
          项目级任务看板 · 独立于会话内的 agent 待办
        </span>
        <button
          type="button"
          className={configBtn}
          onClick={() => setShowConfig(true)}
          data-testid="kanban-config-btn"
        >
          ⚙️ 设置
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => void handleImportFile(e)}
          data-testid="kanban-import-input"
        />
        <button
          type="button"
          className={configBtn}
          onClick={() => void handleExport()}
          data-testid="kanban-export-btn"
        >
          ⬇ 导出
        </button>
        <button
          type="button"
          className={configBtn}
          onClick={() => fileInputRef.current?.click()}
          data-testid="kanban-import-btn"
        >
          ⬆ 导入
        </button>
      </div>
      {ioError && (
        <div className={ioErrorBar} data-testid="kanban-io-error" role="alert">
          {ioError}
        </div>
      )}
      {overflowing && (
        <p className={scrollHint} data-testid="kanban-scroll-hint">
          共 {board.columns.length} 列，可横向滚动查看后面的列
        </p>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <section
          className={boardArea}
          ref={boardRef}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动区域进 Tab 序是 WAI-ARIA scrollable-region 模式——屏幕阅读器用户靠 Tab 聚焦它再用方向键滚动，键盘用户靠它滚动到后续列（实测第 5 列在 1280px 视口外 173px）
          tabIndex={0}
          aria-label="看板列，可横向滚动"
          onFocus={handleBoardFocus}
        >
          {board.columns.map((col) => {
            const colCards = board.cards
              .filter((c) => c.columnId === col.id)
              .sort((a, b) => a.position - b.position)
            return (
              <KanbanColumn
                key={col.id}
                column={col}
                cards={colCards}
                labels={board.labels}
                onCardClick={(c) => setEditingCard(c)}
                onQuickAdd={(title) => addMutation.mutate({ title, columnId: col.id })}
              />
            )
          })}
        </section>
      </DndContext>

      {editingCard && (
        <CardEditDialog
          key={editingCard.id}
          projectId={projectId}
          cardId={editingCard.id}
          initialTitle={editingCard.title}
          initialDescription={editingCard.description}
          initialPriority={editingCard.priority}
          initialLabels={editingCard.labels}
          boardLabels={board.labels}
          onClose={() => setEditingCard(null)}
        />
      )}

      {showConfig && (
        <BoardConfigDialog
          projectId={projectId}
          columns={board.columns}
          labels={board.labels}
          cards={board.cards}
          onClose={() => setShowConfig(false)}
        />
      )}
    </div>
  )
}
