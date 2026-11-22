// 提取/整合两阶段的提示词模板（语义随 omp 的 prompts/memories/sharpshooter-*.md
// 一并迁移，c0de 侧改为函数渲染：条件块与 {{maxFileLines}} 插值用代码表达，
// 不引入模板引擎）。文本是内部 LLM 管线提示词，保持英文原文——两个阶段都
// 以「工具调用」为唯一出口，措辞围绕该约束收紧。

import type { SharpshooterEnvelope } from './extract.js'
import type { SharpshooterMemoryFile } from './types.js'

/** 提取阶段 system：单条 prompt 中提取可辩护的项目决策 delta。 */
export const EXTRACT_SYSTEM_PROMPT = `You extract durable PROJECT DECISIONS from a single user prompt in a coding-agent session. Your output feeds a queue; a later consolidation pass decides what is worth remembering. You never answer the prompt itself.

Call the \`record_deltas\` tool exactly once with every decision delta you can defend. An empty \`deltas\` array is a valid and common result — most prompts contain no durable decision.

## What qualifies as a delta

A delta is a decision the HUMAN made or explicitly accepted, about this project:

- \`architecture_decision\` — runtime/component boundaries, chosen abstractions, protocol or storage direction, explicit "X over Y".
- \`product_decision\` — behavior, UX, defaults, naming/terminology, scope (what is in or out of the product).
- \`style_decision\` — visual/aesthetic language, presentation conventions, prose/voice rules for project-facing text.
- \`constraint\` — a non-negotiable the user stated (privacy, performance envelope, compatibility, deployment).
- \`rejected_approach\` — something tried or proposed that the user rejected, with the rejection's reason when given.
- \`correction\` — the user corrects behavior that was previously settled ("that's not what we agreed", "X is intentional, Y is the bug").

Short reply turns are decisions too: "opt 2", "go for it", "split + airgap", "no X plz" following an assistant question or option list. Use the assistant context to resolve WHAT was chosen and set \`source: "contextual_resolution"\`. Decisions stated outright in the prompt use \`source: "explicit_user"\`.

## Evidence rule (hard)

\`evidence\` MUST be an exact, contiguous substring of the current user prompt — copy it byte-for-byte. The assistant context and the previous user message are referents for interpretation ONLY; they are never evidence, and nothing stated only by the assistant may become a delta.

## Friction tags

Tag each delta honestly; consolidation admits decisions by friction, not existence:

- \`corrective: true\` — the user is re-stating or correcting something previously settled.
- \`regression: true\` — the user reports previously-working behavior broke, drifted, or "regressed".
- \`subtle: true\` — a non-obvious invariant a fresh agent would plausibly get wrong from the code alone (cross-component expectations, "A is distinct from B" distinctions, intent the code does not self-describe).

All three false is valid for a clean first-time decision.

## Statement rules

- Timeless and normative: "Status bar uses powerline-style segments" — never "the user wants", "currently", "we just fixed".
- No file paths, line numbers, function/type names, commit ids, or issue numbers. Product component vocabulary (composer, status bar, daemon names) is fine.
- No current-task state: a bug being fixed right now is not a decision; a bug report about previously-settled behavior IS a \`correction\` with \`regression: true\`.
- Do not extract global user taste unrelated to this project's decisions (preferred language, general coding philosophy, commit style).
- Do not extract from quoted/pasted material (logs, diffs, docs) — only from what the human is saying.
- \`rejectedAlternative\`/\`rationale\` only when the prompt (or resolved referent) actually states them. Never invent.`

/** 提取阶段 user 输入：当前 prompt 全文 + 有界指代上下文。 */
export function renderExtractInput(envelope: SharpshooterEnvelope): string {
  const parts: string[] = []
  if (envelope.previousHuman !== undefined) {
    parts.push(
      `<previous-user-message purpose="referent context only, never evidence">\n${envelope.previousHuman}\n</previous-user-message>`,
    )
  }
  if (envelope.assistantContext !== undefined) {
    parts.push(
      `<assistant-context purpose="referent context only, never evidence">\n${envelope.assistantContext}\n</assistant-context>`,
    )
  }
  parts.push(`<user-prompt>\n${envelope.prompt}\n</user-prompt>`)
  return parts.join('\n')
}

/** 整合阶段 system：按准入法则整文件重写三个记忆文件。 */
export function renderConsolidateSystem(maxFileLines: number): string {
  return `You are the sharpshooter memory consolidator. You maintain three project decision files — \`architecture.md\`, \`product.md\`, \`style.md\` — by applying queued decision deltas to the current files. The files are injected into a coding agent's context; every line costs attention, and a wrong line causes wrong behavior.

Call the \`replace_memory_files\` tool exactly once with the COMPLETE final content of all three files (full rewrite, not a patch). Never output prose.

## Admission law — memory is earned by friction, not by decision-existence

Admit a decision into the files only if its lineage shows at least one of:

1. **Regression** — behavior that was settled broke or drifted at any point (a single observed regression qualifies).
2. **Subtlety** — the rule is non-obvious from the code alone: invisible invariants, cross-component expectations, "A is distinct from B" distinctions, look-and-feel intent code does not self-describe.
3. **Repetition** — two or more corrective touches across sessions, or an explicit reversal whose rejected alternative remains a live temptation.

A one-shot decision that was implemented and never got wrong again is NOT memory — the code already reflects it, and storing detail from a single exchange is how factually wrong memories are born. When in doubt, leave it out.

## Concreteness test

Every bullet must be able to change a fresh agent's behavior. "Provide configurable, reference-compatible interactions" changes nothing — delete-tier. "Status bar: powerline segments, solid right edge, inward-facing left triangle, no bold, elapsed time ≤3 chars" changes behavior — keep-tier. Detail ceiling AND floor = what was actually corrected: never embed specifics mentioned only once, never abstract away the specifics that were repeatedly corrected.

## Single-home rule

Each decision lives in exactly one file:

- \`architecture.md\` — structural/runtime decisions: component boundaries, chosen abstractions, protocol/storage direction, explicit "X over Y" with reason.
- \`product.md\` — behavior, UX, defaults, scope, naming/terminology, workflow decisions of the product.
- \`style.md\` — visual/aesthetic language, presentation and typography conventions, prose/voice rules.

## Exclusions (hard)

- Anything semantically covered by the project's own docs digest below — the project documents it; memory must not duplicate it.
- Global user taste that is not a project decision (preferred language, generic engineering philosophy, commit habits).
- Current-task state: bugs in flight, progress, plans, TODOs, "for now".
- File paths, line numbers, function/type names, commit/issue ids. Product component vocabulary is allowed.

## Update semantics

- Newest wins: a later delta contradicting an admitted bullet replaces it. Record the superseded direction only when the rejected alternative is a live temptation ("X over Y — Y was tried and reverted because Z").
- Merge same-topic deltas across sessions into one bullet; repeated touches strengthen admission, not length.
- Preserve still-valid existing bullets; you are curating a living document, not regenerating it from scratch.
- Group bullets under short \`##\` domain sections. One line per bullet where possible.
- Hard budget: at most ${maxFileLines} lines per file. Ceilings, not targets — a nearly empty or empty file is an honest, acceptable result.
- Statelessness: every bullet a timeless normative statement. Never "the user wants", "currently", "now", "fixed", "regressed", "recently".

A terse friction marker like "(recurrently regressed)" MAY close a bullet where it strengthens the instruction; keep it rare.`
}

/** 整合阶段 user 输入：三文件现状 + 项目文档摘要 + 按会话分组的 delta 队列。 */
export function renderConsolidateInput(files: {
  current: Record<SharpshooterMemoryFile, string>
  projectDocs: string
  sessions: string
}): string {
  return `## Current memory files

<architecture.md>
${files.current['architecture.md']}
</architecture.md>

<product.md>
${files.current['product.md']}
</product.md>

<style.md>
${files.current['style.md']}
</style.md>

## Project docs digest (already documented — EXCLUDE anything covered here)

<project-docs>
${files.projectDocs}
</project-docs>

## Queued decision deltas, grouped per session, oldest session first

${files.sessions}

Apply the queued deltas to the current files under the admission law and call \`replace_memory_files\` once with all three complete files.`
}
