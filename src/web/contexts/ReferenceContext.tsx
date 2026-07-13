import type { ReactNode } from 'react'
import { createContext, useContext, useState } from 'react'

/**
 * 文件引用 API：供侧边栏文件树、右侧预览面板等「跨组件」调用，
 * 把文件/选中文本注入到中间消息输入框（Composer）。
 *
 * 采用 state 驱动而非可变 holder：Composer 挂载时 setApi 写入实现，
 * Provider 重渲染使所有消费方立即拿到最新 API——避免可变 holder 下
 * 消费方因 Context value 引用不变而持有陈旧 null 的问题。
 */
export type FileReferenceAPI = {
  /** 插入文件引用 pill（FilePart，发送时附带整个文件内容到上下文）。 */
  insertFileReference: (path: string) => void
  /** 插入选区引用 pill（SnippetPart）：编辑器显示位置标签，
   * hover 展示 snippet，提交时注入代码块以省一次 read 调用。 */
  insertSnippetReference: (
    path: string,
    lineStart: number,
    lineEnd: number,
    snippet: string,
  ) => void
  /** 插入终端内容引用 pill（TerminalPart）：编辑器显示标签，
   * 提交时展开为 ```terminal 代码块注入 LLM 上下文。 */
  insertTerminalReference: (label: string, content: string) => void
}

type FileReferenceContextValue = {
  api: FileReferenceAPI | null
  setApi: (api: FileReferenceAPI | null) => void
}

const ReferenceContext = createContext<FileReferenceContextValue | null>(null)

/** Provider 组件：内部 useState 管理 api，Composer 挂载/卸载时 setApi。 */
export function FileReferenceProvider({ children }: { children: ReactNode }) {
  const [api, setApi] = useState<FileReferenceAPI | null>(null)
  return <ReferenceContext.Provider value={{ api, setApi }}>{children}</ReferenceContext.Provider>
}

/** 导出原始 Context，供测试直接包裹。 */
export { ReferenceContext }

/** 消费文件引用 API；Provider 缺失或 Composer 未就绪时返回 null（调用方应判空）。 */
export function useFileReference(): FileReferenceAPI | null {
  return useContext(ReferenceContext)?.api ?? null
}

/** Composer 专用：返回 setApi 用于注册/注销 API。 */
export function useFileReferenceSetter(): (api: FileReferenceAPI | null) => void {
  return useContext(ReferenceContext)?.setApi ?? (() => {})
}
