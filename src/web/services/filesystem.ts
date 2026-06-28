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

const filesystemAPI = {
  /** 浏览指定路径下的子目录（用于项目路径自动补全）。 */
  browse: (path: string) =>
    apiRequest<BrowseResult>(`/api/filesystem/browse?path=${encodeURIComponent(path)}`),
  /** 获取 home 目录路径。 */
  home: () => apiRequest<{ path: string }>('/api/filesystem/home'),
}

export type { BrowseResult, DirectoryEntry }
export { filesystemAPI }
