import { get } from '@/services/api.js'

/** 目录列表项。 */
type DirectoryEntry = {
  name: string
  path: string
}

/** 目录浏览响应。 */
type BrowseResult = {
  path: string
  directories: DirectoryEntry[]
}

/** 目录搜索响应。 */
type SearchResult = {
  items: string[]
}

const filesystemAPI = {
  /** 浏览指定路径下的子目录（用于项目路径自动补全）。 */
  browse: (path: string) =>
    get<BrowseResult>(`/api/filesystem/browse?path=${encodeURIComponent(path)}`),
  /** 获取 home 目录路径。 */
  home: () => get<{ path: string }>('/api/filesystem/home'),
  /** 递归搜索目录（命中深层目录，返回相对 directory 的目录路径）。 */
  search: (directory: string, q: string, limit = 50) =>
    get<SearchResult>(
      `/api/filesystem/search?directory=${encodeURIComponent(directory)}&q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
}

export type { BrowseResult, DirectoryEntry, SearchResult }
export { filesystemAPI }

/** 文件名搜索查询键（useFileSearch 与 FileBrowser 搜索框共享缓存；queryFn 是
 *  file.ts 的 fileAPI.search）。挂 'files' 复数前缀树——与 hooks/gitState.ts 的
 *  git-* 键同根；和 file.ts 的 fileKey（'file' 单数前缀，文件内容键）不同树，勿混。 */
export function filesSearchKey(query: string, projectId?: string) {
  return ['files', 'search', query, projectId ?? ''] as const
}
