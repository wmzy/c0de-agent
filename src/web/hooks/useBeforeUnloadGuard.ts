import { useEffect } from 'react'

/**
 * 刷新/关闭页面前提示未保存更改（原生 beforeunload 通道）。
 * useBlocker 只覆盖 SPA 内导航与浏览器后退/前进；关闭标签页/整页刷新必须走
 * 浏览器原生 beforeunload——preventDefault + returnValue='' 双保险（新旧两种
 * 规范各自认一个）。clean 时零监听器挂载，离开 dirty 态即卸载。
 * Settings 配置草稿与 FilePreview 未保存编辑曾各持一份逐字副本，收敛于此。
 */
export function useBeforeUnloadGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])
}
