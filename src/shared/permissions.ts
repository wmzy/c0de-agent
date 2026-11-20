/** 权限确认超时兜底拒绝后暂停 run 的暂停原因（区别于用户主动暂停）：
 *  附重试指引：被拒工具不会自动重试，用户回来后需要知道可以要求 agent 重做。
 *  主 chat 与工作流通道仅主语（对话/工作流）不同；服务端 pauseCascade 与
 *  前端 permission_expired 本地合成、ChatSession 横幅兜底共用此模板，
 *  此前三处各持一份文案已漂移。 */
export function permissionTimeoutPauseReason(subject: '对话' | '工作流'): string {
  return `权限确认超时：该工具已被自动拒绝，${subject}已暂停。点击「恢复」后可直接要求 agent 重试该工具`
}
