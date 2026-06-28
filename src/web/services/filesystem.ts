import { apiRequest } from './api.js'

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
    apiRequest<BrowseResult>(`/api/filesystem/browse?path=${encodeURIComponent(path)}`),
  /** 获取 home 目录路径。 */
  home: () => apiRequest<{ path: string }>('/api/filesystem/home'),
  /** 递归搜索目录（命中深层目录，返回相对 directory 的目录路径）。 */
  search: (directory: string, q: string, limit = 50) =>
    apiRequest<SearchResult>(
      `/api/filesystem/search?directory=${encodeURIComponent(directory)}&q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
}

export type { BrowseResult, DirectoryEntry, SearchResult }
export { filesystemAPI }
