// IME（输入法）组合态判定：回车确认候选词期间不得当作「提交/选择/导航」。
//
// 中文/日文/韩文输入法用回车确认候选词时，浏览器照常派发 keydown
// （key === 'Enter'，且 isComposing === true、keyCode === 229）——不看组合态的
// 处理器会把**未确认的候选文本**当成最终输入：目录名/任务名/分支名输到一半按
// 回车确认候选，却被当成「提交表单 / 选择建议 / 按输入导航」执行；Escape 取消
// 候选也会被当成「取消重命名」。所有对 Enter/Escape/方向键做语义动作的键盘
// 处理器（输入框上下文）都必须先过本判定。
//
// 单一实现：判定散落在各组件里必然出现「有的查、有的漏」——与 stripMarkdownCode /
// isPrototypeKey 同口径收敛。

/** 判定所需字段子集：React 合成事件（经 nativeEvent 暴露原生事件）与原生 KeyboardEvent 均满足。 */
type ImeKeyboardEvent = {
  isComposing?: boolean
  /** 已废弃但仍被各浏览器在 IME 组合期间设为 229（老 Safari 不置 isComposing）。 */
  keyCode?: number
  nativeEvent?: ImeKeyboardEvent
}

/** 该键盘事件是否处于 IME 组合中（候选词未确认）。 */
export function isImeComposing(e: ImeKeyboardEvent): boolean {
  const target = e.nativeEvent ?? e
  return target.isComposing === true || target.keyCode === 229
}
