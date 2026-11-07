import { del, get, post, put, withProjectId } from '@/services/api.js'

import type {
  CommitResponse,
  FileContent,
  FileEntry,
  FileSearchResult,
  GitStatusMap,
} from '@/types/index.js'

/**
 * 把工作区相对路径编码进 URL path 段：逐段 encodeURIComponent，保留 `/` 分隔符。
 * encodeURI 不编码 `?` 与 `#`——文件名含它们时 URL 会在该处截断为
 * query/fragment，服务端 c.req.path 拿到被截断的路径，静默读写/删除**同名前缀
 * 的另一个文件**（如删除 `a?b.txt` 会删掉 `a`）。逐段编码后服务端按段完整解码
 * （routes/files.ts 的 extractFilePath），拿到完整原路径。
 */
export function encodeFilePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

const fileAPI = {
  list: (path: string, projectId?: string) =>
    get<FileEntry[]>(withProjectId(`/api/files?path=${encodeURIComponent(path)}`, projectId)),
  read: (path: string, projectId?: string) =>
    get<FileContent>(withProjectId(`/api/files/${encodeFilePath(path)}`, projectId)),
  write: (path: string, content: string, projectId?: string) =>
    put<{ path: string; written: boolean }>(
      withProjectId(`/api/files/${encodeFilePath(path)}`, projectId),
      { content },
    ),
  search: (query: string, projectId?: string) =>
    get<FileSearchResult[]>(
      withProjectId(`/api/files/search?q=${encodeURIComponent(query)}`, projectId),
    ),
  delete: (path: string, projectId?: string) =>
    del<{ path: string; trashed: boolean }>(
      withProjectId(`/api/files/${encodeFilePath(path)}`, projectId),
    ),
  gitStatus: (projectId?: string) =>
    get<GitStatusMap>(withProjectId('/api/files/git-status', projectId)),
  gitCommit: (
    projectId?: string,
    body?: { mode?: string; message?: string; suggestions?: string[] },
  ) => post<CommitResponse>(withProjectId('/api/files/git-commit', projectId), body || undefined),
  gitBranch: (projectId?: string) =>
    get<{ branch: string | null }>(withProjectId('/api/files/git-branch', projectId)),
  gitLastCommit: (projectId?: string) =>
    get<{
      commit: { subject: string; hash: string; author: string; date: string } | null
    }>(withProjectId('/api/files/git-last-commit', projectId)),
  gitBranches: (projectId?: string) =>
    get<{ branches: { name: string; current: boolean; lastSubject: string | null }[] }>(
      withProjectId('/api/files/git-branches', projectId),
    ),
  gitCheckout: (projectId: string, branch: string) =>
    post<{ branch: string }>(withProjectId('/api/files/git-checkout', projectId), {
      branch,
    }),
  gitBranchCreate: (projectId: string, name: string) =>
    post<{ branch: string }>(withProjectId('/api/files/git-branch-create', projectId), { name }),
}

export { fileAPI }
