// combobox 输入框的语义键判定（框架无关）。
//
// ModelSelector 与 DirectoryPicker 各持一份手写的 combobox 状态机（开/关/高亮 +
// 键盘导航）。两机的 Esc/Enter 层级消费语义已各自演化（DirectoryPicker 修过
// 「未处理键透传」的死键 bug、Enter 无高亮时回落首项；ModelSelector 的 Escape
// 连过滤词一起复位），**不得数平**——收敛的只是「哪些键属于 combobox 语义键」
// 这一判定：键集合单点后，任一调用点新增键位（如 Tab 关闭）不会与另一处漂移。
//
// 与 isImeComposing 的分工：IME 组合态守卫仍由调用点先做（且必须先做——
// DirectoryPicker 组合中的键**不透传**给宿主，与「非语义键透传」是两条路，不能
// 在本判定里合并成一个 null）。

/** combobox 语义键的种类。 */
export type ComboboxKeyAction = 'next' | 'prev' | 'commit' | 'dismiss'

/** 判定所需的最小字段（React 合成事件与原生 KeyboardEvent 均满足）。 */
type ComboboxKeyboardEvent = { key: string }

/** 该键是否为 combobox 语义键：↓/↑ 移动高亮、Enter 确认、Escape 收起；
 *  其余键返回 null（由调用点决定默认行为/透传）。 */
export function comboboxKeyAction(e: ComboboxKeyboardEvent): ComboboxKeyAction | null {
  switch (e.key) {
    case 'ArrowDown':
      return 'next'
    case 'ArrowUp':
      return 'prev'
    case 'Enter':
      return 'commit'
    case 'Escape':
      return 'dismiss'
    default:
      return null
  }
}
