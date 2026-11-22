/** Advisor 影子审查模块的最小公共形状。 */

/** note 严重级别：
 * - nit：不紧急的改进建议（下一 turn 边界合入即可）；
 * - concern：主 agent 可能走错方向/漏掉实质问题，值得打断提醒；
 * - blocker：继续执行明显违背用户指令或必然返工，必须立即打断。 */
export type AdvisorSeverity = 'nit' | 'concern' | 'blocker'

/** 一条经 emission-guard 准入的审查 note。severity 由 runtime 归一化
 *  （LLM 工具参数缺省/非法一律回退 nit），故这里是必填字段。 */
export type AdvisorNote = {
  /** 给被审查 agent 的具体、简短、可行动的建议（注入 steering 的正文）。 */
  note: string
  severity: AdvisorSeverity
}
