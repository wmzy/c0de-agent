/**
 * "workflowz" keyword support — Dynamic Workflow（spec: dynamic-workflow-design）。
 *
 * 用户在消息中包含独立单词 `workflowz` 时：
 *  1. 后端检测到关键词（prose 感知，忽略代码块/路径/大小写变体）
 *  2. 向当轮注入一条隐藏 system 通知（steering），引导模型用 `task` 工具批量 fan-out
 *     做确定性的多子 agent 工作流分解
 *
 * 复刻自 oh-my-pi 的 modes/workflow.ts，适配 c0de-agent 的 task 工具 schema：
 *  - 批量模式：`{ subagent_type, context, tasks: [{ prompt, description? }] }`
 *  - 单任务模式：`{ subagent_type?, prompt, description? }`
 */

// 检测：小写关键词，两侧不得是 ASCII 词/路径字符（字母、数字、_、.、/、-）。
// 用 [\w./-] 而非 \S 做边界，使 CJK 字符和中文标点也能当边界——
// 中文无词间空格，用 \S 会拒绝「请workflowz」「workflowz。」等合法写法。
// 仍拒绝 reworkflowz / workflowzed / workflowz.test.ts 等。
const WORKFLOW_WORD = /(?<![\w./-])workflowz(?![\w./-])/

/**
 * 判断 `text` 是否在 prose 中包含独立关键词 "workflowz"。
 *
 * 边界为「非 ASCII 词/路径字符」，因此 CJK 字符和中文标点也算合法边界
 * （中文无词间空格）；但仍拒绝 workflowzed / reworkflowz / workflowz.test.ts
 * 等拉丁词续或路径内嵌形式。
 *
 * 简化版 prose 检测：移除 ``` 代码块和 `行内代码` 后再匹配。
 */
export function containsWorkflow(text: string): boolean {
  // 移除 ``` ... ``` 代码块
  const withoutBlocks = text.replace(/```[\s\S]*?```/g, '')
  // 移除 `行内代码`
  const withoutInline = withoutBlocks.replace(/`[^`]*`/g, '')
  return WORKFLOW_WORD.test(withoutInline)
}

/**
 * 工作流通知：注入为 steering system 消息，引导模型用 task 工具做批量 fan-out。
 *
 * 适配 c0de-agent 的 task 工具 schema（subagent_type + context + tasks[]）。
 */
export const WORKFLOW_NOTICE = `<workflow-notice>
The user's message contains the **workflowz** keyword. This triggers the Dynamic Workflow system. You MUST first determine the user's intent:

<intent-detection>
- **Create/save a workflow** — the user says "workflowz 创建/建/save/make a workflow" — they want you to GENERATE a reusable JavaScript workflow script and save it. Jump to <create-workflow> below.
- **Execute a workflow** — the user says "workflowz 扫描/审查/重构/测试..." — they want you to drive a deterministic multi-subagent fan-out using the \`task\` tool. Jump to <task-contract> below.
- **Both** — "workflowz 创建一个扫描工作流" means create the workflow script first, then optionally run it.
</intent-detection>

<create-workflow>
When the intent is to CREATE a workflow, you MUST generate a **JavaScript** file (NOT bash/shell/python) with this exact structure:

\`\`\`js
// File: .c0de/workflows/<name>.js
export const meta = {
  name: '<name>',           // lowercase, kebab-case, matches filename
  description: '<description>',
  argsHint: '[optional args]',
  phases: ['phase1', 'phase2', ...],
  timeout: 300,            // optional, seconds
}

export default async function workflow(ctx) {
  const { runSubagents, runSubagent, utils, progress, project, args } = ctx

  // Phase 1: progress('starting...', { phase: 'phase1' })
  // Call runSubagents for parallel fan-out:
  const results = await runSubagents('researcher', [
    { assignment: '...', description: 'task 1' },
    { assignment: '...', description: 'task 2' },
  ])
  // results: [{ ok: true, output: '...' }, { ok: false, error: '...' }]

  // Phase 2: verify / cross-check results
  // Phase 3: return summary
  return { output: 'summary text', data: { ... } }
}
\`\`\`

**Rules:**
1. The file MUST be \`.js\` with ES module exports (\`export const meta\` + \`export default async function\`).
2. Save to \`<project_root>/.c0de/workflows/<name>.js\` — use the \`write\` tool.
3. Use \`ctx.runSubagents(type, tasks[])\` for parallel dispatch, \`ctx.runSubagent(type, params)\` for single dispatch.
4. Available subagent types: \`general\`, \`coder\`, \`researcher\`, \`reviewer\`.
5. Use \`ctx.utils\` for file ops: \`glob(pattern)\`, \`grep(pattern, path?)\`, \`read(path, range?)\`, \`splitByDirectory(dir, {depth, ignore})\`.
6. Use \`ctx.progress(message, { phase })\` to report progress.
7. Parse subagent output with \`JSON.parse(r.output)\` — subagents return text.
8. Return \`{ output: 'summary', data: {...} }\` as the final result.
9. NEVER generate bash/shell scripts, python scripts, or any non-JS format for workflows.
10. After writing the file, tell the user they can run it with \`/workflow run <name>\` or via POST /api/workflows/:name/run.
</create-workflow>

<when>
When the intent is to EXECUTE a workflow (not create), you may do a brief inline scout (1-2 tool calls to list files/scope the work), but your NEXT action after scouting MUST be a \`task\` tool call to fan out. Do NOT spend the entire turn reading files inline — that defeats the purpose. Common shapes:
- **Understand** — parallel readers over subsystems → structured map.
- **Design** — independent approaches → scored synthesis.
- **Review** — split dimensions → find per dimension → adversarially verify each finding.
- **Research** — multi-modal sweep → deep-read the hits → synthesize.
- **Migrate** — discover sites → transform each → verify.
</when>

<task-contract>
Call \`task\` once per independent fan-out batch using the batch form:

    task({
      subagent_type: "coder",
      context: "shared background all subagents need",
      tasks: [
        { role: "coder", assignment: "specific assignment for agent 1", description: "short label" },
        { role: "reviewer", assignment: "specific assignment for agent 2", description: "short label" },
      ]
    })

Available subagent types: \`general\` (full tools, recursive), \`coder\` (implementation), \`researcher\` (read-only scout), \`reviewer\` (code review). Pick the type that matches each task's intent.

\`context\` carries shared background prepended to every subagent's prompt — put the shared contract, conventions, and coordination rules here.

Each task in \`tasks[]\` must be self-contained:
- \`role\`: specialist type for this sub-task (e.g. coder, reviewer, researcher)
- \`assignment\`: exact target (files, symbols, subsystem) + what to do + acceptance criteria
- \`description\`: short label for the UI

Each subagent runs in an isolated session and returns its result via the \`yield\` tool. Subagents skip formatters, linters, and project-wide tests — the parent runs shared proof once after all results return.
</task-contract>

<structure>
Decompose first, then batch the independent leaves:

    task({
      subagent_type: "coder",
      context: "# Goal\nImplement feature X across the codebase\n# Constraints\nFollow existing patterns...\n# Contract\nReturn findings as structured data...",
      tasks: [
        { role: "coder", assignment: "# Target\nsrc/auth/login.ts\n# Change\nAdd rate limiting to login endpoint\n# Acceptance\nRate limiter works, tests pass", description: "Login rate limiting" },
        { role: "coder", assignment: "# Target\nsrc/auth/signup.ts\n# Change\nAdd input validation\n# Acceptance\nValidation blocks invalid emails", description: "Signup validation" },
      ]
    })

Prefer one wide batch over serial calls when work items do not share files. If tasks overlap, have agents coordinate before editing.
</structure>

<patterns>
- **Adversarial verify** — dispatch skeptical reviewers with distinct targets, then keep only findings you can verify against source.
- **Perspective-diverse review** — use separate correctness, security, performance roles instead of identical reviewers.
- **Completeness critic** — after the first batch, dispatch one read-only critic that asks what was missed.
- **No silent caps** — if you bound coverage (top-N, sampling), state what was dropped and why.
- **Parent owns closure** — subagents return evidence; the parent reads it, resolves contradictions, runs proof, and makes the final decision.
</patterns>

<execution>
- **You MUST call the \`task\` tool** — this is the defining action of a workflowz request. A response that only does inline read/glob/edit without dispatching sub-agents is a failure.
- Capture multi-phase workflow state in the visible todo system when available.
- Batch independent subagents in one \`task\` call.
- Give every subagent a narrow target, explicit non-goals, and a concrete return packet.
- After fan-out returns, read the results, patch or decide, and run the shared gate.
- Keep going until the task is closed — returned fan-out is a step, not a stopping point.
</execution>
</workflow-notice>`

/**
 * 构建工作流 steering 通知：基础通知 + 可选的已注册工作流列表。
 * 无工作流时退化为纯基础通知（向后兼容）。
 */
export function buildWorkflowNotice(
  workflows?: Array<{ name: string; description: string }>,
): string {
  const registeredSection =
    workflows && workflows.length > 0
      ? `\n<registered-workflows>
Available saved workflow scripts (run with /workflow run <name> or POST /api/workflows/:name/run):
${workflows.map((w) => `- ${w.name}: ${w.description}`).join('\n')}
To create a new workflow, generate a .js file with export const meta + export default async function(ctx) and save it to .c0de/workflows/<name>.js.
</registered-workflows>`
      : `\n<registered-workflows>
No saved workflow scripts yet. When the user asks to create a workflow, generate a .js file (export const meta + export default async function) and save it to .c0de/workflows/<name>.js.
</registered-workflows>`

  return WORKFLOW_NOTICE + registeredSection
}
