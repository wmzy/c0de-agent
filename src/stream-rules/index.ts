// TTSR 流规则（regex 子集）公共出口：组装点（chat/print 等）从这里取发现
// 与 checker 工厂；parse/types 单独导出供诊断与测试复用。

export type {
  DiscoverStreamRulesOptions,
  StreamRuleDiscovery,
  StreamRuleIssue,
} from './discover.js'
export { discoverStreamRules } from './discover.js'
export {
  createStreamRuleChecker,
  renderStreamRuleInjection,
  STREAM_BUFFER_LIMIT,
} from './matcher.js'
export type { StreamRuleParseResult } from './parse.js'
export { parseStreamRule } from './parse.js'
export type { StreamRule, StreamRuleRepeatMode } from './types.js'
