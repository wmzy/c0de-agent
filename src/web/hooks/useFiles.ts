import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { fileAPI } from '@/services/file.js'
import { filesSearchKey } from '@/services/filesystem.js'
import type { FileSearchResult } from '@/types/index.js'

/** @文件提及搜索：仅当 query 非空时请求。复用已有 fileAPI.search。
 *  placeholderData=keepPreviousData：query 变化时旧结果保留（isPlaceholderData），
 *  由 at-menu 按 subsequence 即时收窄（oh-my-pi 在途收窄口径），浮层逐字收窄
 *  而不是每次击键闪「搜索中」。 */
export function useFileSearch(query: string, projectId?: string) {
  return useQuery({
    queryKey: filesSearchKey(query, projectId),
    queryFn: () => fileAPI.search(query, projectId),
    enabled: query.trim().length > 0,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  })
}

export type { FileSearchResult }
