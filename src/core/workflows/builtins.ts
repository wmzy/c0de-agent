import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WorkflowEntry, WorkflowModule } from './types.js'

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

  const allFindings = utils.parseJsonArray(scans, 'findings')

  progress(\`交叉验证 \${allFindings.length} 个发现...\`, { phase: 'verify' })
  const verified = await runSubagents('reviewer', allFindings.map((f) => ({
    assignment: \`对抗审查以下安全发现，判断是否为真实问题还是误报：
\${JSON.stringify(f, null, 2)}

返回 JSON：{ confirmed: boolean, reason: string, adjustedSeverity?: 'critical|warning|info' }\`,
    description: '验证发现',
  })))

  const confirmed = utils.parseJsonObjects(verified).filter((v) => v?.confirmed)

  progress('生成报告...', { phase: 'report' })
  const summary = \`扫描 \${modules.length} 个模块，发现 \${allFindings.length} 个候选问题，\${confirmed.length} 个经交叉验证确认。\`

  return { output: summary, data: { confirmed, totalCandidates: allFindings.length } }
}`

// ── code-review ──

const CODE_REVIEW_SOURCE = `export const meta = {
  name: 'code-review',
  description: '多维度代码审查：correctness/security/performance/maintainability 各派独立 reviewer',
  argsHint: '[审查目标路径]',
  phases: ['review', 'merge'],
}

export default async function workflow(ctx) {
  const { runSubagents, utils, progress, project, args } = ctx
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

  const allFindings = utils.parseJsonArray(reviews, 'findings')

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

// ── review ──

const REVIEW_SOURCE = `export const meta = {
  name: 'review',
  description: 'Diff 审查：并行 reviewer 按文件分组审查 + P0-P3 分级 + ship/block 判定',
  argsHint: '[--base <ref> | <commit>] [补充要求]',
  phases: ['diff', 'review', 'verdict'],
  timeout: 600,
}

export default async function workflow(ctx) {
  const { runSubagents, utils, progress, project, args } = ctx
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const git = async (...cmd) => {
    try {
      // execFile 非 tty：git 不着色，无需 --no-color（且 merge-base/rev-parse
      // 不认该选项）
      const { stdout } = await exec('git', cmd, {
        cwd: project.rootDir,
        maxBuffer: 128 * 1024 * 1024,
      })
      return stdout
    } catch (err) {
      throw new Error('git ' + cmd.join(' ') + ' 失败：' + (err && err.stderr ? String(err.stderr).trim() : err && err.message ? err.message : String(err)))
    }
  }

  // —— 参数解析：--base <ref>（分支三点 diff）| <hex>（单提交）| 缺省未提交 ——
  const parts = (args || '').split(/\\s+/).filter(Boolean)
  let mode = 'uncommitted'
  let ref = ''
  const extra = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p === '--base') {
      ref = parts[i + 1]
      if (!ref) throw new Error('用法：/review [--base <ref> | <commit>] [补充要求]')
      mode = 'base'
      i++
    } else if (!ref && /^[0-9a-f]{7,40}$/.test(p)) {
      mode = 'commit'
      ref = p
    } else extra.push(p)
  }
  const extraText = extra.join(' ')

  // —— diff 范围解析（numstat + patch）——
  const fetchScope = async (m, r) => {
    if (m === 'commit') {
      await git('rev-parse', '--verify', r + '^{commit}')
      return {
        desc: 'commit ' + r.slice(0, 12),
        numstat: await git('show', r, '--numstat', '--format='),
        patch: await git('show', r, '--format='),
      }
    }
    if (m === 'base') {
      const mb = (await git('merge-base', r, 'HEAD')).trim()
      return {
        desc: r + '...HEAD（merge-base ' + mb.slice(0, 7) + '）',
        numstat: await git('diff', mb, 'HEAD', '--numstat'),
        patch: await git('diff', mb, 'HEAD'),
      }
    }
    return {
      desc: '未提交变更（staged + unstaged；不含 untracked 文件）',
      numstat: await git('diff', 'HEAD', '--numstat'),
      patch: await git('diff', 'HEAD'),
    }
  }

  progress('解析 diff 范围...', { phase: 'diff' })
  let scope = await fetchScope(mode, ref)
  let fellBackToHead = false
  if (mode === 'uncommitted' && scope.numstat.trim() === '') {
    // 工作区干净：自动回退审查最近一次提交（与 omp 无 ref 时的默认一致）
    scope = await fetchScope('commit', 'HEAD')
    scope.desc = '最近一次提交 HEAD（工作区无未提交变更）'
    fellBackToHead = true
  }

  // —— numstat → 文件清单（排除锁文件/产物/快照/二进制）——
  const files = []
  for (const line of scope.numstat.split('\\n')) {
    const m = /^(\\d+|\\-)\\t(\\d+|\\-)\\t(.+)$/.exec(line)
    if (m) {
      files.push({
        added: m[1] === '-' ? 0 : Number(m[1]),
        removed: m[2] === '-' ? 0 : Number(m[2]),
        path: m[3],
      })
    }
  }
  const EXCLUDE = [
    /(^|\\/)(node_modules|vendor|dist|build|coverage|\\.next|target)\\//,
    /package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock|bun\\.lockb?$|Cargo\\.lock|poetry\\.lock|composer\\.lock|Gemfile\\.lock|go\\.sum|flake\\.lock|deno\\.lock/i,
    /\\.(min\\.(js|css)|map|snap|png|jpe?g|gif|webp|svg|ico|pdf|woff2?|ttf|otf|eot|exe|so|dylib|dll)$/i,
    /\\.generated\\./,
  ]
  const included = files.filter((f) => !EXCLUDE.some((re) => re.test(f.path)))
  if (included.length === 0) {
    return {
      output: '审查范围（' + scope.desc + '）内没有可审查的文本变更（全部被排除：锁文件/构建产物/快照/二进制）。',
      data: { scope: scope.desc, verdict: 'ship', findings: [], counts: { p0: 0, p1: 0, p2: 0, p3: 0 } },
    }
  }

  // —— patch 按文件切分 ——
  const patchMap = new Map()
  const diffRe = /^diff --git a\\/(.+) b\\/(.+)$/
  let curPath = null
  let curSeg = []
  for (const line of scope.patch.split('\\n')) {
    const m = diffRe.exec(line)
    if (m) {
      if (curPath) patchMap.set(curPath, curSeg.join('\\n'))
      curPath = m[2]
      curSeg = [line]
    } else if (curPath) curSeg.push(line)
  }
  if (curPath) patchMap.set(curPath, curSeg.join('\\n'))

  // —— reviewer 数量（omp 启发式：按变更行数 + 文件数）与按目录局部性分组 ——
  const churn = included.reduce((s, f) => s + f.added + f.removed, 0)
  const nf = included.length
  let agentCount
  if (churn < 100 || nf <= 2) agentCount = 1
  else if (churn < 500) agentCount = Math.min(2, nf)
  else if (churn < 2000) agentCount = Math.min(4, Math.ceil(nf / 3))
  else if (churn < 5000) agentCount = Math.min(8, Math.ceil(nf / 2))
  else agentCount = Math.min(16, nf)

  const sorted = [...included].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const target = Math.ceil(churn / agentCount)
  const groups = []
  let cur = []
  let curChurn = 0
  for (const f of sorted) {
    cur.push(f)
    curChurn += f.added + f.removed
    if (curChurn >= target && groups.length < agentCount - 1) {
      groups.push(cur)
      cur = []
      curChurn = 0
    }
  }
  if (cur.length > 0) groups.push(cur)

  // —— 每个 reviewer 的 assignment（组内 diff 内联，超预算降级为 read 指引）——
  const FILE_CAP = 8000
  const GROUP_CAP = 48000
  const assignments = groups.map((group, gi) => {
    let budget = GROUP_CAP
    const sections = []
    for (const f of group) {
      let seg = (patchMap.get(f.path) || '').trimEnd()
      if (!seg) seg = '(无文本 diff)'
      if (seg.length > FILE_CAP) seg = seg.slice(0, FILE_CAP) + '\\n…（截断；用 read 工具读 ' + f.path + ' 获取完整上下文）'
      if (seg.length > budget) seg = '(组 diff 预算耗尽；用 read 工具读 ' + f.path + '）'
      budget -= seg.length
      sections.push('--- ' + f.path + ' (+' + f.added + ' -' + f.removed + ')\\n' + seg)
    }
    const lines = [
      '你是 diff 审查专家，负责第 ' + (gi + 1) + '/' + groups.length + ' 组文件。审查范围：' + scope.desc + '。仓库根：' + project.rootDir + '。',
      '',
      '<criteria>',
      '- 只报本次 diff 引入的问题；finding 必须锚定 diff 内的 file + line（新文件用新行号）',
      '- 每条 finding 要有可证明的影响（provable impact）、可操作（actionable）、不基于未声明的假设',
      '- 跨函数/模块边界的类型与分支变更：用 read 追到消费侧确认后再下结论',
      '- 禁止修改文件、禁止构建/执行——只读审查（read/grep/glob）',
      '</criteria>',
      '',
      '<diff>',
      sections.join('\\n\\n'),
      '</diff>',
      extraText ? '用户补充要求：' + extraText : '',
      '',
      "用 yield 返回 JSON：{ findings: [{ severity: 'critical'|'warning'|'info', file, line, issue, suggestion, priority, confidence }], summary, verdict: 'correct'|'incorrect', explanation }",
      '- priority：0=阻断发布（P0），1=应尽快修（P1），2=建议（P2），3=可选（P3）；缺省按 severity 推断（critical→0，warning→1，info→2）',
      '- confidence：0.0-1.0，你对「这是真实问题」的把握',
      "- verdict：'incorrect' 仅当存在 bug/阻断级问题；explanation 为 1-3 句结论摘要",
    ]
    return { assignment: lines.filter(Boolean).join('\\n'), description: '审查第 ' + (gi + 1) + ' 组（' + group.length + ' 文件）' }
  })

  progress('并行 ' + groups.length + ' 个 reviewer 审查（' + nf + ' 文件，churn ' + churn + ' 行）...', { phase: 'review' })
  const reviews = await runSubagents('reviewer', assignments)
  const parsed = utils.parseJsonObjects(reviews)

  // —— 聚合：去重（file+line+issue 前缀）→ priority/confidence 归一 → 排序 ——
  const SEV_PRIORITY = { critical: 0, warning: 1, info: 2 }
  const seen = new Set()
  const findings = []
  for (const r of parsed) {
    for (const f of (r && Array.isArray(r.findings) ? r.findings : [])) {
      if (!f || typeof f !== 'object' || !f.file || !f.issue) continue
      const key = String(f.file) + ':' + String(f.line == null ? '' : f.line) + ':' + String(f.issue).toLowerCase().replace(/\\s+/g, ' ').trim().slice(0, 80)
      if (seen.has(key)) continue
      seen.add(key)
      const priority =
        typeof f.priority === 'number' && f.priority >= 0 && f.priority <= 3
          ? Math.round(f.priority)
          : (SEV_PRIORITY[f.severity] != null ? SEV_PRIORITY[f.severity] : 2)
      const confidence = typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.5
      findings.push({
        severity: f.severity || 'info',
        file: String(f.file),
        line: typeof f.line === 'number' ? f.line : null,
        issue: String(f.issue),
        suggestion: f.suggestion ? String(f.suggestion) : '',
        priority,
        confidence,
      })
    }
  }
  findings.sort((a, b) => a.priority - b.priority || b.confidence - a.confidence)

  const counts = { p0: 0, p1: 0, p2: 0, p3: 0 }
  for (const f of findings) counts['p' + f.priority]++
  const verdictIncorrect = parsed.some((r) => r && r.verdict === 'incorrect')
  const blocked = findings.some((f) => f.priority === 0 && f.confidence >= 0.5) || verdictIncorrect

  progress('聚合 ' + findings.length + ' 条发现，判定 ' + (blocked ? 'BLOCK' : 'SHIP'), { phase: 'verdict' })

  const lines = [
    '## 审查结论：' + (blocked ? 'BLOCK — 存在阻断级问题，不建议直接合入' : 'SHIP — 未发现阻断级问题'),
    '',
    '范围：' + scope.desc + ' ｜ 文件 ' + nf + ' ｜ P0:' + counts.p0 + ' P1:' + counts.p1 + ' P2:' + counts.p2 + ' P3:' + counts.p3,
  ]
  for (const r of parsed) {
    if (r && (r.explanation || r.summary)) lines.push('- reviewer：' + (r.explanation || r.summary))
  }
  if (findings.length > 0) {
    lines.push('', '## 发现（P0→P3，同优先级按把握度降序）')
    for (const f of findings) {
      lines.push(
        'P' + f.priority + ' [' + f.confidence.toFixed(2) + '] ' + f.file + (f.line != null ? ':' + f.line : '') + ' — ' + f.issue +
          (f.suggestion ? '\\n  建议：' + f.suggestion : ''),
      )
    }
  }
  if (mode === 'uncommitted' && !fellBackToHead) {
    lines.push('', '注：git diff 不含未跟踪（untracked）文件；如需一并审查请先 git add。')
  }

  return {
    output: lines.join('\\n'),
    data: { scope: scope.desc, verdict: blocked ? 'block' : 'ship', counts, findings, reviewerSummaries: parsed.map((r) => r && (r.explanation || r.summary)).filter(Boolean) },
  }
}`

// ── migration-check ──

const MIGRATION_CHECK_SOURCE = `export const meta = {
  name: 'migration-check',
  description: '迁移影响检查：分析变更的 breaking changes / deprecated / new features',
  argsHint: '[base-branch或commit]',
  phases: ['diff', 'analyze', 'report'],
}

export default async function workflow(ctx) {
  const { runSubagents, utils, progress, project, args } = ctx
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

  const allItems = utils.parseJsonArray(analyses, 'items')

  progress('生成迁移报告...', { phase: 'report' })
  const high = allItems.filter((i) => i.impact === 'high').length
  const medium = allItems.filter((i) => i.impact === 'medium').length
  const low = allItems.filter((i) => i.impact === 'low').length

  return {
    output: \`迁移检查完成：\${allItems.length} 个变更项（\${high} high, \${medium} medium, \${low} low）\`,
    data: { items: allItems, summary: { high, medium, low, total: allItems.length } },
  }
}`

// ── factory：源码字符串 → WorkflowEntry（保证 show === run）──

/**
 * 把内置工作流的源码字符串编译为 WorkflowEntry：写入临时 .js → dynamic import →
 * 取出 meta 与 default。这样 /workflow show 展示的源码就是实际执行的代码，
 * 杜绝「源码字符串」与「TS 函数」两份副本各自漂移的维护陷阱。
 */
async function sourceToEntry(source: string): Promise<WorkflowEntry> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'wf-builtin-'))
  const tmpFile = join(tmpDir, 'builtin.js')
  writeFileSync(tmpFile, source, 'utf-8')
  try {
    const mod = (await import(pathToFileURL(tmpFile).href)) as Partial<WorkflowModule>
    if (!mod.meta || typeof mod.default !== 'function') {
      throw new Error('builtin workflow source missing `export const meta` or default export')
    }
    return {
      meta: mod.meta,
      source: 'builtin',
      execute: mod.default,
      sourceCode: source,
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** 缓存：内置工作流只动态导入一次。 */
let _builtinWorkflowsCache: WorkflowEntry[] | undefined

/**
 * 构建全部内置工作流条目（动态导入源码字符串）。幂等、内部缓存。
 */
async function createBuiltinWorkflows(): Promise<WorkflowEntry[]> {
  if (_builtinWorkflowsCache) return _builtinWorkflowsCache
  _builtinWorkflowsCache = await Promise.all([
    sourceToEntry(SECURITY_AUDIT_SOURCE),
    sourceToEntry(CODE_REVIEW_SOURCE),
    sourceToEntry(REVIEW_SOURCE),
    sourceToEntry(MIGRATION_CHECK_SOURCE),
  ])
  return _builtinWorkflowsCache
}

// 顶层 await：模块加载时一次性解析，使同步消费方（注册表惰性 getter、slash 回退、
// 单元测试）无需改造即可拿到已解析的内置条目；解析失败则 fail-fast。
const BUILTIN_WORKFLOWS: WorkflowEntry[] = await createBuiltinWorkflows()

export { BUILTIN_WORKFLOWS, createBuiltinWorkflows }
