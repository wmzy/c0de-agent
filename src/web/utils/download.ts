/** 数据序列化为 JSON 并触发浏览器下载（统一挂载版实现）。
 *
 *  会话导出（ChatSession）、看板导出（KanbanView / 项目删除前备份
 *  ProjectIndicator）、配置导出（Settings）四处此前各持一份
 *  `Blob → createObjectURL → a.click() → revokeObjectURL` 手抄，且「游离节点
 *  click」与「挂载 body 后 click 再移除」两种写法并存——游离 click 在部分
 *  环境不触发下载（正是 Settings 版写成挂载的原因），此处统一为挂载版。 */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
