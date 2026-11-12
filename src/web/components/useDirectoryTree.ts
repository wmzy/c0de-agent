// 懒加载目录树的状态机（FileBrowser 与 DirectoryPicker 的单一实现）。
// 两处此前各持一份 treeRoot/expanded/loadingPaths/loadErrors + 近似 loadChildren，
// 且 DirectoryPicker 那份没有世代守卫：换根目录后在飞的懒加载响应仍会写进新树
// （路径恰好命中时不报错、被永久缓存）。收敛于此，守卫内建。
import { type Dispatch, type SetStateAction, useCallback, useState } from 'react'
import type { TreeNode } from '@/components/FileTree.js'
import { setChildren } from '@/components/tree-utils.js'
import { type ScopeGuard, useScopeGuard } from '@/hooks/useScopeGuard.js'
import { messageOf } from '@/utils/errors.js'

export type DirectoryTree = {
  treeRoot: TreeNode | null
  setTreeRoot: Dispatch<SetStateAction<TreeNode | null>>
  expanded: Set<string>
  setExpanded: Dispatch<SetStateAction<Set<string>>>
  loadingPaths: Set<string>
  loadErrors: Map<string, string>
  /** 懒加载某目录的子项（守卫内建；失败落到 loadErrors，可就地重试）。 */
  loadChildren: (dirPath: string) => Promise<void>
  /** 作废在飞请求并清空四份状态（切项目 / 换根目录）。 */
  invalidate: () => void
  /** 世代守卫：调用方在 loadChildren 之外的自定义异步流（删除后改树、reveal 链）
   *  里用 token()/stale() 刻号校验，与懒加载共用同一作废点。 */
  guard: ScopeGuard
}

/**
 * 惰性目录树：子目录首次展开时才拉取（children === undefined），结果经
 * setChildren 不可变并进 treeRoot。
 *
 * 世代守卫（手动模式 useScopeGuard）：作用域切换（FileBrowser 切项目/重试、
 * DirectoryPicker 换根目录）时调用方必须 invalidate()——它会作废世代并清空状态。
 * 在飞的懒加载请求按世代校验后才允许落盘，否则上一个作用域的目录列表会并进
 * 新作用域的树：dirPath 常是相对/同名路径，两边合并「恰好成功」、不报任何错，
 * 而 toggle 只在 children === undefined 时才加载，这份外来清单会被永久缓存到
 * 刷新为止。
 */
export function useDirectoryTree(
  fetchChildren: (dirPath: string) => Promise<TreeNode[]>,
): DirectoryTree {
  const [treeRoot, setTreeRoot] = useState<TreeNode | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  /** 懒加载子目录失败的原因（path → message）。失败不静默落成 children: []——
   *  那正是 FileTree 的「（空）」分支，会把「读不到」说成「没有」。 */
  const [loadErrors, setLoadErrors] = useState<Map<string, string>>(new Map())
  const guard = useScopeGuard()

  const loadChildren = useCallback(
    async (dirPath: string) => {
      const gen = guard.token()
      setLoadingPaths((prev) => new Set(prev).add(dirPath))
      setLoadErrors((prev) => {
        if (!prev.has(dirPath)) return prev
        const next = new Map(prev)
        next.delete(dirPath)
        return next
      })
      try {
        const children = await fetchChildren(dirPath)
        // 世代已变（期间作废过）：这份列表属于上一个作用域，丢弃。
        if (guard.stale(gen)) return
        setTreeRoot((prev) => (prev ? setChildren(prev, dirPath, children) : prev))
      } catch (err) {
        if (guard.stale(gen)) return
        // APIError 是结构体而非 Error 子类，必须结构化取 message（messageOf 口径）。
        setLoadErrors((prev) => new Map(prev).set(dirPath, messageOf(err) || '无法读取该目录'))
      } finally {
        setLoadingPaths((prev) => {
          const next = new Set(prev)
          next.delete(dirPath)
          return next
        })
      }
    },
    [fetchChildren, guard],
  )

  const invalidate = useCallback(() => {
    guard.invalidate()
    setTreeRoot(null)
    setExpanded(new Set())
    setLoadingPaths(new Set())
    setLoadErrors(new Map())
  }, [guard])

  return {
    treeRoot,
    setTreeRoot,
    expanded,
    setExpanded,
    loadingPaths,
    loadErrors,
    loadChildren,
    invalidate,
    guard,
  }
}
