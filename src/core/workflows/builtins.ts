import type { WorkflowContext, WorkflowEntry, WorkflowResult } from './types.js'

// ── security-audit ──

const SECURITY_AUDIT_SOURCE = `export const meta = {
  name: 'security-audit',
  description: '并行安全审计：按目录拆分扫描 → 独立审查员交叉验证 → 汇总报告',
  argsHint: '[扫描目标描述]',
  phases: ['scan', 'verify', 'report'],
}

export default async function workflow(ctx) {
  const { runSubagents, utils, progress, project } = ctx

  progress('拆分代码库为模块...')
  const modules = await utils.splitByDirectory(project.rootDir, { depth: 2 })

  progress(\`并行扫描 \${modules.length} 个模块...\`, { phase: 'scan' })
  const scans = await runSubagents('researcher', modules.map((m) => ({
    assignment: \`你是安全扫描专家。扫描目录 \${m.path} 下的代码，检查以下安全风险：
- SQL 注入风险
- 硬编码密钥 / 密码 / Token
- 权限绕过模式
- XSS / CSRF 风险
- 不安全的依赖使用

文件列表：\${m.files.slice(0, 50).join(', ')}

返回 JSON：{ findings: [{ severity: 'critical|warning|info', file, line, issue, evidence }] }\`,
    description: \`扫描 \${m.name}\`,
  })))

  const allFindings = scans
    .filter((r) => r.ok)
    .flatMap((r) => { try { return JSON.parse(r.output).findings ?? [] } catch { return [] } })

  progress(\`交叉验证 \${allFindings.length} 个发现...\`, { phase: 'verify' })
  const verified = await runSubagents('reviewer', allFindings.map((f) => ({
    assignment: \`对抗审查以下安全发现，判断是否为真实问题还是误报：
\${JSON.stringify(f, null, 2)}

返回 JSON：{ confirmed: boolean, reason: string, adjustedSeverity?: 'critical|warning|info' }\`,
    description: '验证发现',
  })))

  const confirmed = verified
    .filter((r) => r.ok)
    .map((r) => { try { return JSON.parse(r.output) } catch { return null } })
    .filter((v) => v?.confirmed)

  progress('生成报告...', { phase: 'report' })
  const summary = \`扫描 \${modules.length} 个模块，发现 \${allFindings.length} 个候选问题，\${confirmed.length} 个经交叉验证确认。\`

  return { output: summary, data: { confirmed, totalCandidates: allFindings.length } }
}`

const securityAudit: (ctx: WorkflowContext) => Promise<WorkflowResult> = async (ctx) => {
  const { runSubagents, utils, progress, project } = ctx

  progress('拆分代码库为模块...')
  const modules = await utils.splitByDirectory(project.rootDir, { depth: 2 })

  progress(`并行扫描 ${modules.length} 个模块...`, { phase: 'scan' })
  const scans = await runSubagents(
    'researcher',
    modules.map((m) => ({
      assignment: `你是安全扫描专家。扫描目录 ${m.path} 下的代码，检查以下安全风险：
- SQL 注入风险
- 硬编码密钥 / 密码 / Token
- 权限绕过模式
- XSS / CSRF 风险
- 不安全的依赖使用

文件列表：${m.files.slice(0, 50).join(', ')}

返回 JSON：{ findings: [{ severity: 'critical|warning|info', file, line, issue, evidence }] }`,
      description: `扫描 ${m.name}`,
    })),
  )

  const allFindings = scans
    .filter((r) => r.ok)
    .flatMap((r) => {
      try {
        return JSON.parse(r.output).findings ?? []
      } catch {
        return []
      }
    })

  progress(`交叉验证 ${allFindings.length} 个发现...`, { phase: 'verify' })
  const verified = await runSubagents(
    'reviewer',
    allFindings.map((f) => ({
      assignment: `对抗审查以下安全发现，判断是否为真实问题还是误报：
${JSON.stringify(f, null, 2)}

返回 JSON：{ confirmed: boolean, reason: string, adjustedSeverity?: 'critical|warning|info' }`,
      description: '验证发现',
    })),
  )

  const confirmed = verified
    .filter((r) => r.ok)
    .map((r) => {
      try {
        return JSON.parse(r.output)
      } catch {
        return null
      }
    })
    .filter((v) => v?.confirmed)

  progress('生成报告...', { phase: 'report' })
  const summary = `扫描 ${modules.length} 个模块，发现 ${allFindings.length} 个候选问题，${confirmed.length} 个经交叉验证确认。`

  return { output: summary, data: { confirmed, totalCandidates: allFindings.length } }
}

// ── code-review ──

const CODE_REVIEW_SOURCE = `export const meta = {
  name: 'code-review',
  description: '多维度代码审查：correctness/security/performance/maintainability 各派独立 reviewer',
  argsHint: '[审查目标路径]',
  phases: ['review', 'merge'],
}

export default async function workflow(ctx) {
  const { runSubagents, progress, project, args } = ctx
  const target = args || project.rootDir

  const dimensions = ['correctness', 'security', 'performance', 'maintainability']

  progress(\`并行 \${dimensions.length} 个维度审查...\`, { phase: 'review' })
  const reviews = await runSubagents('reviewer', dimensions.map((dim) => ({
    assignment: \`你是 \${dim} 维度的代码审查专家。审查 \${target} 下的代码。

关注点：
\${dim === 'correctness' ? '- 逻辑正确性、边界条件、错误处理' : ''}
\${dim === 'security' ? '- 安全漏洞、输入验证、权限控制' : ''}
\${dim === 'performance' ? '- 性能瓶颈、不必要计算、内存泄漏' : ''}
\${dim === 'maintainability' ? '- 代码可读性、重复代码、命名规范' : ''}

返回 JSON：{ findings: [{ severity: 'critical|warning|info', file, line, issue, suggestion }] }\`,
    description: \`\${dim} 审查\`,
    role: dim,
  })))

  const allFindings = reviews
    .filter((r) => r.ok)
    .flatMap((r) => { try { return JSON.parse(r.output).findings ?? [] } catch { return [] } })

  progress('合并去重并生成报告...', { phase: 'merge' })
  const seen = new Set()
  const deduped = allFindings.filter((f) => {
    const key = \`\${f.file}:\${f.line}:\${f.issue}\`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const critical = deduped.filter((f) => f.severity === 'critical').length
  const warning = deduped.filter((f) => f.severity === 'warning').length
  const info = deduped.filter((f) => f.severity === 'info').length

  return {
    output: \`审查完成：\${critical} critical, \${warning} warning, \${info} info（共 \${deduped.length} 条）\`,
    data: { findings: deduped, summary: { critical, warning, info, total: deduped.length } },
  }
}`

const codeReview: (ctx: WorkflowContext) => Promise<WorkflowResult> = async (ctx) => {
  const { runSubagents, progress, project, args } = ctx
  const target = args || project.rootDir

  const dimensions = ['correctness', 'security', 'performance', 'maintainability']

  progress(`并行 ${dimensions.length} 个维度审查...`, { phase: 'review' })
  const reviews = await runSubagents(
    'reviewer',
    dimensions.map((dim) => ({
      assignment: `你是 ${dim} 维度的代码审查专家。审查 ${target} 下的代码。

关注点：
${dim === 'correctness' ? '- 逻辑正确性、边界条件、错误处理' : ''}
${dim === 'security' ? '- 安全漏洞、输入验证、权限控制' : ''}
${dim === 'performance' ? '- 性能瓶颈、不必要计算、内存泄漏' : ''}
${dim === 'maintainability' ? '- 代码可读性、重复代码、命名规范' : ''}

返回 JSON：{ findings: [{ severity: 'critical|warning|info', file, line, issue, suggestion }] }`,
      description: `${dim} 审查`,
      role: dim,
    })),
  )

  const allFindings = reviews
    .filter((r) => r.ok)
    .flatMap((r) => {
      try {
        return JSON.parse(r.output).findings ?? []
      } catch {
        return []
      }
    })

  progress('合并去重并生成报告...', { phase: 'merge' })
  const seen = new Set()
  const deduped = allFindings.filter((f) => {
    const key = `${f.file}:${f.line}:${f.issue}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const critical = deduped.filter((f) => f.severity === 'critical').length
  const warning = deduped.filter((f) => f.severity === 'warning').length
  const info = deduped.filter((f) => f.severity === 'info').length

  return {
    output: `审查完成：${critical} critical, ${warning} warning, ${info} info（共 ${deduped.length} 条）`,
    data: { findings: deduped, summary: { critical, warning, info, total: deduped.length } },
  }
}

// ── migration-check ──

const MIGRATION_CHECK_SOURCE = `export const meta = {
  name: 'migration-check',
  description: '迁移影响检查：分析变更的 breaking changes / deprecated / new features',
  argsHint: '[base-branch或commit]',
  phases: ['diff', 'analyze', 'report'],
}

export default async function workflow(ctx) {
  const { runSubagents, progress, project, args } = ctx
  const baseRef = args || 'HEAD~1'

  progress(\`分析 \${baseRef} 到当前版本的变更...\`, { phase: 'diff' })

  const categories = ['breaking-changes', 'deprecated', 'new-features']

  progress(\`并行分析 \${categories.length} 个类别...\`, { phase: 'analyze' })
  const analyses = await runSubagents('researcher', categories.map((cat) => ({
    assignment: \`你是代码迁移分析专家。分析项目 \${project.rootDir} 从 \${baseRef} 到当前的变更，
聚焦 \${cat === 'breaking-changes' ? '破坏性变更（API 签名变更、删除、行为变更）' : cat === 'deprecated' ? '已废弃的功能和 API' : '新增功能和特性'}。

返回 JSON：{ items: [{ category: '\${cat}', description, files, impact: 'high|medium|low' }] }\`,
    description: \`\${cat} 分析\`,
    role: cat,
  })))

  const allItems = analyses
    .filter((r) => r.ok)
    .flatMap((r) => { try { return JSON.parse(r.output).items ?? [] } catch { return [] } })

  progress('生成迁移报告...', { phase: 'report' })
  const high = allItems.filter((i) => i.impact === 'high').length
  const medium = allItems.filter((i) => i.impact === 'medium').length
  const low = allItems.filter((i) => i.impact === 'low').length

  return {
    output: \`迁移检查完成：\${allItems.length} 个变更项（\${high} high, \${medium} medium, \${low} low）\`,
    data: { items: allItems, summary: { high, medium, low, total: allItems.length } },
  }
}`

const migrationCheck: (ctx: WorkflowContext) => Promise<WorkflowResult> = async (ctx) => {
  const { runSubagents, progress, project, args } = ctx
  const baseRef = args || 'HEAD~1'

  progress(`分析 ${baseRef} 到当前版本的变更...`, { phase: 'diff' })

  const categories = ['breaking-changes', 'deprecated', 'new-features']

  progress(`并行分析 ${categories.length} 个类别...`, { phase: 'analyze' })
  const analyses = await runSubagents(
    'researcher',
    categories.map((cat) => ({
      assignment: `你是代码迁移分析专家。分析项目 ${project.rootDir} 从 ${baseRef} 到当前的变更，
聚焦 ${cat === 'breaking-changes' ? '破坏性变更（API 签名变更、删除、行为变更）' : cat === 'deprecated' ? '已废弃的功能和 API' : '新增功能和特性'}。

返回 JSON：{ items: [{ category: '${cat}', description, files, impact: 'high|medium|low' }] }`,
      description: `${cat} 分析`,
      role: cat,
    })),
  )

  const allItems = analyses
    .filter((r) => r.ok)
    .flatMap((r) => {
      try {
        return JSON.parse(r.output).items ?? []
      } catch {
        return []
      }
    })

  progress('生成迁移报告...', { phase: 'report' })
  const high = allItems.filter((i) => i.impact === 'high').length
  const medium = allItems.filter((i) => i.impact === 'medium').length
  const low = allItems.filter((i) => i.impact === 'low').length

  return {
    output: `迁移检查完成：${allItems.length} 个变更项（${high} high, ${medium} medium, ${low} low）`,
    data: { items: allItems, summary: { high, medium, low, total: allItems.length } },
  }
}

// ── barrel ──

const BUILTIN_WORKFLOWS: WorkflowEntry[] = [
  {
    meta: {
      name: 'security-audit',
      description: '并行安全审计：按目录拆分扫描 → 独立审查员交叉验证 → 汇总报告',
      argsHint: '[扫描目标描述]',
      phases: ['scan', 'verify', 'report'],
    },
    source: 'builtin',
    execute: securityAudit,
    sourceCode: SECURITY_AUDIT_SOURCE,
  },
  {
    meta: {
      name: 'code-review',
      description:
        '多维度代码审查：correctness/security/performance/maintainability 各派独立 reviewer',
      argsHint: '[审查目标路径]',
      phases: ['review', 'merge'],
    },
    source: 'builtin',
    execute: codeReview,
    sourceCode: CODE_REVIEW_SOURCE,
  },
  {
    meta: {
      name: 'migration-check',
      description: '迁移影响检查：分析变更的 breaking changes / deprecated / new features',
      argsHint: '[base-branch或commit]',
      phases: ['diff', 'analyze', 'report'],
    },
    source: 'builtin',
    execute: migrationCheck,
    sourceCode: MIGRATION_CHECK_SOURCE,
  },
]

export { BUILTIN_WORKFLOWS }
