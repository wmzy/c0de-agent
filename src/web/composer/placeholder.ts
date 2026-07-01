type PlaceholderInput = {
  steerMode: boolean
  hasHistory: boolean
}

/** 动态占位符：按模式/会话状态切换文案。 */
function promptPlaceholder(input: PlaceholderInput): string {
  if (input.steerMode) return '追加运行中指令…'
  if (!input.hasHistory) return '描述你的任务…'
  return '输入消息，/ 查看命令，@ 提及文件'
}

export type { PlaceholderInput }
export { promptPlaceholder }
