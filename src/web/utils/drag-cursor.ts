// 拖拽期间的全局光标 / 文本选择锁。
//
// 拖拽分隔条（终端分屏、面板高度、侧栏宽度）时全局光标需保持 col-resize /
// row-resize，且拖拽期间要禁掉文本选择（否则拖动会把页面文本选中）。两者都写
// 在 document.body.style 上，恢复必须回到**拖拽前**的值。
//
// 此前 TerminalPanel 的分隔条拖拽在 pointerup 里读的是**当前**值（此时已经是拖拽
// 光标与 user-select:none），清空后又把读到的值写回去——拖拽结束后全站光标永久
// 停在 col-resize、文本选择永久禁用（直到刷新，或另一次拖拽的清理把残留值当成
// 「原值」继续保留）。同一模式在三处拖拽中重复，收敛为本模块单一实现。

/** 拖拽前的 body 内联样式快照。 */
export type BodyCursorSnapshot = { cursor: string; userSelect: string }

/** 锁定全局光标并禁用文本选择；返回拖拽前快照，必须交给 restoreBodyCursor。 */
export function lockBodyCursor(cursor: string): BodyCursorSnapshot {
  const snapshot: BodyCursorSnapshot = {
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
  }
  document.body.style.cursor = cursor
  document.body.style.userSelect = 'none'
  return snapshot
}

/** 恢复 lockBodyCursor 之前的 body 内联样式。 */
export function restoreBodyCursor(snapshot: BodyCursorSnapshot): void {
  document.body.style.cursor = snapshot.cursor
  document.body.style.userSelect = snapshot.userSelect
}
