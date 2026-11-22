// TTSR 流规则（regex 子集）的类型定义。
//
// omp 的 rule/ttsr 体系支持 condition/astCondition/question 三类触发与
// text/thinking/tool 多 scope；这里收敛为一期子集：仅 text scope 的正则
// 触发。规则文件位于 .c0de/rules/*.md（项目级）与全局配置目录 rules/*.md，
// 项目级文件属仓库信任面（已入信任指纹 kind 'stream-rules'），门禁由组装
// 点负责，本模块只接收 projectTrusted 开关。

/** repeat 门控模式：
 *  - once：本进程（checker 生命周期）内每规则至多触发 1 次；
 *  - turn-gap：距上次命中 ≥ repeatGap 个流（resetStream 计数）后才可再触发；
 *  - always：每个流内都可再触发（同流内仍只上报一次，loop 命中即断流）。 */
export type StreamRuleRepeatMode = 'once' | 'turn-gap' | 'always'

/** 已编译的流规则。conditions 在解析期预编译——非法正则整条规则跳过
 *  （fail-closed：宁可少一条规则，不做静默降级的半失效匹配）。 */
export type StreamRule = {
  /** 规则名：frontmatter name，缺省用文件名（去 .md）。同名时项目级覆盖全局。 */
  name: string
  /** 预编译触发正则（无 flags 编译，避免 /g 的 lastIndex 跨调用状态）；任一命中即触发。 */
  conditions: RegExp[]
  /** 流作用域。一期仅 'text'（其他值在解析层报错跳过）。 */
  scope: 'text'
  /** 触发重复模式，默认 once。 */
  repeatMode: StreamRuleRepeatMode
  /** turn-gap 模式的最小流间隔，默认 10。 */
  repeatGap: number
  /** 注入指引正文（frontmatter 剥离后的 markdown）。 */
  body: string
  /** 规则文件来源路径（同名覆盖与诊断用）。 */
  source: string
}
