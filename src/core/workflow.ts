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

// 检测：小写关键词，两侧为空白或字符串边界。非全局，`.test` 无状态。
const WORKFLOW_WORD = /(?<!\S)workflowz(?!\S)/

/**
 * 判断 `text` 是否在 prose 中包含独立关键词 "workflowz"
 * （小写、空白分隔）——不在代码块、行内代码或路径中。
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
The user's message contains the **workflowz** keyword: drive this task as a deterministic multi-subagent workflow. Use the \`task\` tool for batched fan-out — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before you commit), or to take on scale one context can't hold (audits, migrations, broad sweeps). This overrides any default tendency to do the whole task inline when fanning out would be more thorough.

<when>
Worth it when the task benefits from decomposition + parallel coverage, or from independent/adversarial cross-checking. For a quick lookup or single edit, just do it directly — don't spin up agents. Scout inline first (list the files, scope the diff, find the call sites) to discover the work list, then fan out over it. Common shapes:
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
        { prompt: "specific assignment for agent 1", description: "short label" },
        { prompt: "specific assignment for agent 2", description: "short label" },
      ]
    })

Available subagent types: \`general\` (full tools, recursive), \`coder\` (implementation), \`researcher\` (read-only scout), \`reviewer\` (code review). Pick the type that matches each task's intent.

\`context\` carries shared background prepended to every subagent's prompt — put the shared contract, conventions, and coordination rules here.

Each task in \`tasks[]\` must be self-contained:
- \`prompt\`: exact target (files, symbols, subsystem) + what to do + acceptance criteria
- \`description\`: short label for the UI

Each subagent runs in an isolated session and returns its result via the \`yield\` tool. Subagents skip formatters, linters, and project-wide tests — the parent runs shared proof once after all results return.
</task-contract>

<structure>
Decompose first, then batch the independent leaves:

    task({
      subagent_type: "coder",
      context: "# Goal\\nImplement feature X across the codebase\\n# Constraints\\nFollow existing patterns...\\n# Contract\\nReturn findings as structured data...",
      tasks: [
        { prompt: "# Target\\nsrc/auth/login.ts\\n# Change\\nAdd rate limiting to login endpoint\\n# Acceptance\\nRate limiter works, tests pass", description: "Login rate limiting" },
        { prompt: "# Target\\nsrc/auth/signup.ts\\n# Change\\nAdd input validation\\n# Acceptance\\nValidation blocks invalid emails", description: "Signup validation" },
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
- Capture multi-phase workflow state in the visible todo system when available.
- Batch independent subagents in one \`task\` call.
- Give every subagent a narrow target, explicit non-goals, and a concrete return packet.
- After fan-out returns, read the results, patch or decide, and run the shared gate.
- Keep going until the task is closed — returned fan-out is a step, not a stopping point.
</execution>
</workflow-notice>`
