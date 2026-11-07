// 跨会话内容搜索（标题树/回收站列表之外的补充结果）：SessionList（项目会话）
// 与 RecycleBin（回收站）曾各持一份「300ms 防抖 → sessionAPI.search useQuery
// （enabled: 词长 ≥1）→ 三态（进行中/失败/结果）」，收敛为同一实现。
// 两处唯一合法差异是 includeDeleted；staleTime 统一 10s（RecycleBin 原先缺失
// 属复制漂移而非语义——同一个查询没有理由两种新鲜度口径）。
import type { Session } from '@shared/types/message.js'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { useDebouncedValue } from '@/hooks/useDebouncedValue.js'
import { sessionAPI } from '@/services/session.js'
import { messageOf } from '@/utils/errors.js'

/** 单条命中：会话 + 命中部位（标题/消息内容）。 */
export type SessionContentMatch = { session: Session; matchedBy: 'title' | 'content' }

/**
 * 搜索控制器：search/debounced 供输入框绑定与本地过滤（标题树、孤儿分组按
 * 标题筛）；results/pending/error/errorMessage/refetch 是服务端查询三态。
 *
 * 阈值 1 而非 2：单字符查询此前被静默丢弃，而本地过滤照常按 1 个字收敛——
 * 两边同时为假时会列出未过滤的全量条目，搜索框里有字却看不到任何收敛；
 * 服务端对单字符正常返回。
 *
 * pending 的完整口径 = 防抖未落地 || 请求在飞（含 RQ 默认 retry 2 次重试）：
 * 防抖那 300ms 里本地过滤已生效、结果区还是旧的，把这段时间也算进「搜索中」，
 * 才不会先闪一次「无匹配」再翻成结果；失败后 error 分支给原因 + 重试入口。
 */
export function useSessionContentSearch(
  projectId: string,
  opts?: { includeDeleted?: boolean },
): {
  /** 搜索框原始输入（绑定输入框；本地标题过滤也用它）。 */
  search: string
  setSearch: (v: string) => void
  /** 防抖落地后的查询词（trim 过；空串 = 未在搜索）。 */
  debounced: string
  /** 立即清空输入与防抖词：切项目复位时不得在防抖窗口内拿旧词查新项目。 */
  reset: () => void
  /** 服务端结果（未在搜索或尚无数据时 undefined）。 */
  results: SessionContentMatch[] | undefined
  /** 「正在搜索」的完整口径（见上）。 */
  pending: boolean
  /** 查询失败（重试耗尽后为 true）。 */
  error: boolean
  /** 失败原因（messageOf 口径；未失败为 null）。 */
  errorMessage: string | null
  /** 手动重试。 */
  refetch: () => void
} {
  const includeDeleted = opts?.includeDeleted ?? false
  const [search, setSearch] = useState('')
  const trimmed = search.trim()
  const [debounced, setDebounced] = useDebouncedValue(trimmed, 300)
  const reset = useCallback(() => {
    setSearch('')
    setDebounced('')
  }, [setDebounced])
  const {
    data,
    isLoading,
    isError,
    error,
    refetch: rqRefetch,
  } = useQuery({
    queryKey: ['sessions', 'search', projectId, debounced, includeDeleted],
    queryFn: () =>
      includeDeleted
        ? sessionAPI.search(debounced, projectId, true)
        : sessionAPI.search(debounced, projectId),
    enabled: debounced.length >= 1,
    staleTime: 10_000,
  })
  return {
    search,
    setSearch,
    debounced,
    reset,
    results: data?.results,
    pending: trimmed.length >= 1 && (trimmed !== debounced || isLoading),
    error: isError,
    errorMessage: error ? messageOf(error) : null,
    refetch: () => void rqRefetch(),
  }
}
