import { createContext, useContext } from 'react'

/** 行范围（1-indexed，闭区间）。用于引用片段定位与高亮。 */
export type LineRange = { start: number; end: number }

/** 预览目标：path + 可选高亮范围；null 表示关闭预览。 */
export type FileTarget = { path: string; range?: LineRange } | null

/**
 * 变更前否决钩子：openFile/closeFile 在真正改选中态之前调用它，
 * 返回 false 表示本次变更被拦下（注册方负责与用户确认后再重放）。
 */
export type FileChangeGuard = (next: FileTarget) => boolean

/** 「当前是否存在未保存的文件修改」探针（由 FilePreview 注册）。 */
export type DirtyProbe = () => boolean

/** 文件选中状态：ChatPage 持有，通过 context 下发给 ToolView 和 panel。 */
export type FileSelection = {
  /** 当前选中的文件路径；null 时 panel 不渲染。 */
  selectedFile: string | null
  /** 打开文件预览（设置 selectedFile）；可选 range 用于定位并高亮指定行范围（如点击 snippet pill）。 */
  openFile: (path: string, range?: LineRange) => void
  /** 关闭文件预览（清空 selectedFile）。 */
  closeFile: () => void
  /** 最近一次 openFile 请求的行范围；FilePreview 监听变化后滚动并高亮。null/缺省表示不高亮。 */
  revealRange?: LineRange | null
  /**
   * 注册「变更前否决」钩子——由 FilePreview 注册，因为编辑器脏状态与「放弃修改？」
   * 确认弹窗都归它所有。openFile/closeFile 改状态前先问它：返回 false 即拦下本次
   * 变更，由 FilePreview 弹确认框、用户确认后再重放。
   *
   * 没有它，未保存的编辑会在切换文件时被静默丢弃（旧编辑器随 query 换 key 卸载，
   * 缓冲区只剩内存里那一份）。
   */
  registerGuard?: (fn: FileChangeGuard | null) => void
  /**
   * 注册「当前是否有未保存的文件修改」探针（同样由 FilePreview 提供）。
   *
   * registerGuard 只能拦住「面板内换文件/关闭」这条由本 context 发起的通道；
   * 而 FilePreview 的 useBlocker 还会拦下**离开本页**的应用内导航。会离开本页的
   * 动作据此在动手之前就能知道结果，而不是等导航被 veto 了才发现自己已经造成了
   * 半截状态——例如草稿页发送首条消息必须先跳到会话页（两条 path 平级 → ChatPage
   * 连同预览面板一起卸载，故刻意不豁免），脏时那次导航必被拦下。
   */
  registerDirtyProbe?: (fn: DirtyProbe | null) => void
  /** 便捷读取：当前是否有未保存的文件修改（无预览面板时恒 false）。 */
  hasUnsavedEdits?: () => boolean
}

export const FileSelectionContext = createContext<FileSelection | null>(null)

/** 消费文件选中状态；Provider 缺失时抛错（避免静默失灵）。 */
export function useFileSelection(): FileSelection {
  const ctx = useContext(FileSelectionContext)
  if (!ctx) throw new Error('useFileSelection must be used within FileSelectionContext')
  return ctx
}
