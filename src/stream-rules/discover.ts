// 流规则发现：全局 `<全局配置目录>/rules/*.md` + 项目 `<cwd>/.c0de/rules/*.md`。
//
// 项目级 .md 属仓库自带的规则面（与 plugins/workflows 同级信任面，指纹由
// trust.ts 负责）——projectTrusted=false 时整体不用项目目录（fail-closed），
// 只信任用户自己维护的全局规则。

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveGlobalConfigDir } from '../core/config.js'
import { parseStreamRule } from './parse.js'
import type { StreamRule } from './types.js'

export type StreamRuleIssue = { source: string; error: string }

export type StreamRuleDiscovery = {
  /** 去重后的规则（同名项目级覆盖全局，覆盖保位使顺序稳定）。 */
  rules: StreamRule[]
  /** 文件级失败清单（非法正则/缺 condition/读取失败等），由组装点决定如何呈现。 */
  issues: StreamRuleIssue[]
}

export type DiscoverStreamRulesOptions = {
  /** 项目目录是否通过信任门禁；缺省 false（fail-closed，仅全局规则）。 */
  projectTrusted?: boolean
}

/** 读单个规则目录：目录不存在=无规则（首次使用时全局目录通常也不存在），
 *  文件名排序保证规则顺序确定（匹配「首个命中即返」的优先级稳定）。 */
function loadRuleDir(
  dir: string,
  byName: Map<string, StreamRule>,
  issues: StreamRuleIssue[],
): void {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return
  }
  for (const file of files.sort()) {
    if (!file.endsWith('.md')) continue
    const source = join(dir, file)
    let md: string
    try {
      md = readFileSync(source, 'utf8')
    } catch (error) {
      issues.push({
        source,
        error: `读取失败：${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }
    const result = parseStreamRule(md, source)
    if (result.ok) byName.set(result.rule.name, result.rule)
    else issues.push({ source, error: result.error })
  }
}

export function discoverStreamRules(
  cwd: string,
  opts: DiscoverStreamRulesOptions = {},
): StreamRuleDiscovery {
  const byName = new Map<string, StreamRule>()
  const issues: StreamRuleIssue[] = []

  loadRuleDir(join(resolveGlobalConfigDir(), 'rules'), byName, issues)
  if (opts.projectTrusted) loadRuleDir(join(cwd, '.c0de', 'rules'), byName, issues)

  return { rules: [...byName.values()], issues }
}
