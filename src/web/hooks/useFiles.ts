import { useQuery } from '@tanstack/react-query'
import { fileAPI } from '../services/file.js'
import type { FileSearchResult } from '../types/index.js'

/** @文件提及搜索：仅当 query 非空时请求。复用已有 fileAPI.search。 */
export function useFileSearch(query: string) {
  return useQuery({
    queryKey: ['files', 'search', query],
    queryFn: () => fileAPI.search(query),
    enabled: query.trim().length > 0,
    staleTime: 10_000,
  })
}

export type { FileSearchResult }
