import { createContext, useContext } from 'react'

/** 行范围（1-indexed，闭区间）。用于引用片段定位与高亮。 */
export type LineRange = { start: number; end: number }

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
}

export const FileSelectionContext = createContext<FileSelection | null>(null)

/** 消费文件选中状态；Provider 缺失时抛错（避免静默失灵）。 */
export function useFileSelection(): FileSelection {
  const ctx = useContext(FileSelectionContext)
  if (!ctx) throw new Error('useFileSelection must be used within FileSelectionContext')
  return ctx
}
