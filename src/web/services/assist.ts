import { get, post } from '@/services/api.js'

/**
 * 交互辅助（assist.*，oh-my-pi 口径迁移）的 API 面。两个端点都是显式计费的
 * side-turn：调用方（usePromptPrediction / useIdleRecap）必须以空闲/空输入为
 * 前置，不得在每次击键或渲染时触发。
 */
const assistAPI = {
  /** 预测用户下一条消息（ghost 文本）。prediction=null 表示无预测（含服务端
   *  失败的静默兜底）——调用方不显示任何东西。 */
  predictPrompt: (sessionId: string) =>
    post<{ prediction: string | null }>(`/api/sessions/${sessionId}/predict-prompt`),
  /** 离场回顾。服务端按最后一条消息幂等缓存（metadata.lastRecap），时间线
   *  未新增时重复请求不再计费。 */
  recap: (sessionId: string) =>
    get<{ recap: string | null; cached: boolean }>(`/api/sessions/${sessionId}/recap`),
}

export { assistAPI }
