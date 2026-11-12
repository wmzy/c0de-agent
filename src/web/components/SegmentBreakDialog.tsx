import { useRef, useState } from 'react'
import {
  confirmActions,
  confirmBodyText,
  confirmBtn,
  confirmPrimaryBtn,
} from '@/components/confirmDialogStyles.js'
import { Dialog, useDialogDismiss } from '@/components/Dialog.js'

/**
 * 段切换确认弹窗：切换 provider/model/tools 将开新上下文段，需用户确认。
 * 三选项：继续（仅开新段）/ 顺便压缩会话（压缩后再开新段）/ 取消（还原选择）。
 *
 * 在途锁：三个选项都返回「这次选择是否已完成」。此前它们是 fire-and-forget
 * （调用方写 `void chat.confirmBreak(true)`），弹窗在压缩请求在途时继续可交互：
 * 用户按「取消」/Esc/✕ 只清掉 pendingSegmentBreak、界面看着恢复平静，压缩返回后
 * useChat 仍会照常 setState + doStream 把那条消息发出去——用户明确取消了，消息
 * 却发出去了，且全程没有任何提示；连点两次「顺便压缩会话」也会发出两次 compact。
 * 现在按下的那一刻起整块锁住（按钮 disabled + Dialog closeDisabled，Esc/点背景/
 * ✕ 一并拦住），直到这次选择真正落地。compacting 用于把按钮文案换成「压缩中…」。
 */
export function SegmentBreakDialog({
  activeSegment,
  onConfirm,
  onCompact,
  onCancel,
}: {
  activeSegment: { provider: string; model: string; tools: string[] }
  onConfirm: () => void | Promise<void>
  onCompact: () => void | Promise<void>
  onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [compacting, setCompacting] = useState(false)
  // 重入判定用 ref：同一个 tick 内的连击（React 还没把 disabled 写回 DOM、也没
  // 把 busy state 冲出来）必须当场挡住。
  const busyRef = useRef(false)
  const run = (fn: () => void | Promise<void>, isCompact: boolean) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    if (isCompact) setCompacting(true)
    const done = () => {
      busyRef.current = false
      setBusy(false)
      setCompacting(false)
    }
    // 同步调用回调（既有「点击即回调」的契约不变），只按返回值挂落点。
    let result: void | Promise<void>
    try {
      result = fn()
    } catch (err) {
      done()
      throw err
    }
    void Promise.resolve(result).finally(done)
  }
  // 在途锁的行为兜底：closeDisabled 与按钮 disabled 之外，「取消」点击同口径拒发。
  const dismiss = useDialogDismiss(onCancel, busy)
  return (
    <Dialog
      onClose={dismiss}
      closeDisabled={busy}
      title="切换模型或工具"
      width="min(420px, 92vw)"
      testId="segment-break-dialog"
      footer={
        <div className={confirmActions}>
          <button
            type="button"
            className={confirmBtn}
            onClick={dismiss}
            disabled={busy}
            data-testid="segment-break-cancel"
          >
            取消
          </button>
          <button
            type="button"
            className={confirmBtn}
            onClick={() => run(onCompact, true)}
            disabled={busy}
            data-testid="segment-break-compact"
          >
            {compacting ? '压缩中…' : '顺便压缩会话'}
          </button>
          <button
            type="button"
            className={confirmPrimaryBtn}
            onClick={() => run(onConfirm, false)}
            disabled={busy}
            data-testid="segment-break-confirm"
          >
            继续
          </button>
        </div>
      }
    >
      <div className={confirmBodyText}>
        当前对话使用 {activeSegment.provider}/{activeSegment.model}（{activeSegment.tools.length}{' '}
        个工具）。切换后，新消息将基于新的模型/工具继续；之前的对话内容会完整保留，
        但不再作为新回复的直接上下文基础——新段首轮需重新读取整个上下文， 可能产生额外的 token
        费用。「顺便压缩会话」会先把早前对话总结成摘要， 让新模型快速了解背景，同时降低新段的 token
        开销。
      </div>
    </Dialog>
  )
}
