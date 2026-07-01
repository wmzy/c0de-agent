import { createContext, useContext } from 'react'

/** 文件选中状态：ChatPage 持有，通过 context 下发给 ToolView 和 panel。 */
export type FileSelection = {
  /** 当前选中的文件路径；null 时 panel 不渲染。 */
  selectedFile: string | null
  /** 打开文件预览（设置 selectedFile）。 */
  openFile: (path: string) => void
  /** 关闭文件预览（清空 selectedFile）。 */
  closeFile: () => void
}

export const FileSelectionContext = createContext<FileSelection | null>(null)

/** 消费文件选中状态；Provider 缺失时抛错（避免静默失灵）。 */
export function useFileSelection(): FileSelection {
  const ctx = useContext(FileSelectionContext)
  if (!ctx) throw new Error('useFileSelection must be used within FileSelectionContext')
  return ctx
}
