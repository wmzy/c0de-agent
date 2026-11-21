import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveGlobalConfigDir } from './config.js'
import { EMPTY_CONTEXT_FILES, renderContextFilesSection } from './context-files.js'
import { PROMPT_BODIES } from './prompts.generated.js'
import { builtinCommands } from './slash.js'
import type { PromptBuildContext, PromptRegistry, PromptSection } from './types.js'
import { WORKFLOW_SCRIPT_TEMPLATE } from './workflow.js'

// ── Static section bodies ─────────────────────────────────
// The .md sources live in src/core/prompts/ and are inlined (committed) as
// src/core/prompts.generated.ts — regenerate with `node scripts/gen-prompts.mjs`.
// Sections whose bodies are dynamic (systemPrompt, tool list, project info,
// skills, agents, slash commands, workflow format) are composed in TS below
// and have no .md source.

/** Body of a built-in static section from the generated catalog. The registry
 *  test guards drift (every static section id must have a .md source), so the
 *  ?? '' fallback is unreachable in a consistent tree. */
function builtinBody(id: string): string {
  return PROMPT_BODIES[id] ?? ''
}

// ── Registry ──────────────────────────────────────────────

/** Built-in section ids in priority order. */
export const BUILTIN_SECTION_IDS = [
  'role',
  'systemPrompt',
  'engineering',
  'tool-usage',
  'codebase',
  'constraints',
  'execution-workflow',
  'verification',
  'delivery-contract',
  'git-safety',
  'tone',
  'project',
  'repo-rules',
  'skills',
  'agents',
  'slash-commands',
  'workflow-format',
] as const

/** Built-in sections. Dynamic bodies (tool list, project info, skills) use `render`. */
function builtinSections(): PromptSection[] {
  return [
    { id: 'role', content: builtinBody('role'), priority: 0 },
    {
      id: 'systemPrompt',
      content: '',
      priority: 5,
      condition: (c) => Boolean(c.config.systemPrompt),
      render: (c) => c.config.systemPrompt ?? '',
    },
    { id: 'engineering', content: builtinBody('engineering'), priority: 10 },
    {
      id: 'tool-usage',
      content: '',
      priority: 20,
      condition: (c) => c.tools.length > 0,
      render: (c) => {
        const lines = ['## Available Tools']
        for (const tool of c.tools) lines.push(`- **${tool.name}**: ${tool.description}`)
        lines.push(builtinBody('tool-usage'))
        return lines.join('\n')
      },
    },
    { id: 'codebase', content: builtinBody('codebase'), priority: 30 },
    { id: 'constraints', content: builtinBody('constraints'), priority: 40 },
    { id: 'execution-workflow', content: builtinBody('execution-workflow'), priority: 50 },
    { id: 'verification', content: builtinBody('verification'), priority: 60 },
    { id: 'delivery-contract', content: builtinBody('delivery-contract'), priority: 70 },
    { id: 'git-safety', content: builtinBody('git-safety'), priority: 80 },
    { id: 'tone', content: builtinBody('tone'), priority: 90 },
    {
      id: 'project',
      content: '',
      priority: 100,
      render: (c) => {
        const lines = ['## Project Context']
        lines.push(`- Name: ${c.projectInfo.name}`)
        lines.push(`- Language: ${c.projectInfo.language}`)
        if (c.projectInfo.framework) lines.push(`- Framework: ${c.projectInfo.framework}`)
        lines.push(`- Root: ${c.projectInfo.rootDir}`)
        if (c.projectInfo.gitBranch) lines.push(`- Git Branch: ${c.projectInfo.gitBranch}`)
        return lines.join('\n')
      },
    },
    {
      id: 'repo-rules',
      content: '',
      priority: 105,
      condition: (c) => renderContextFilesSection(c.contextFiles ?? EMPTY_CONTEXT_FILES) !== '',
      render: (c) => renderContextFilesSection(c.contextFiles ?? EMPTY_CONTEXT_FILES),
    },
    {
      id: 'skills',
      content: '',
      priority: 110,
      condition: (c) => Boolean(c.skills && c.skills.length > 0),
      render: (c) => {
        const lines = ['## Loaded Skills']
        for (const skill of c.skills ?? []) lines.push(`- ${skill}`)
        return lines.join('\n')
      },
    },
    // spec §17.2：有子 agent 时列出可委托 agent（插件/配置注入）。
    {
      id: 'agents',
      content: '',
      priority: 115,
      condition: (c) => Boolean(c.agents && c.agents.length > 0),
      render: (c) => {
        const lines = ['## Available Agents']
        for (const agent of c.agents ?? []) lines.push(`- ${agent}`)
        return lines.join('\n')
      },
    },
    // spec §17.2：始终列出可用 slash 命令，让模型知道可调用哪些命令。
    {
      id: 'slash-commands',
      content: '',
      priority: 120,
      render: () => {
        const lines = ['## Slash Commands']
        for (const cmd of builtinCommands) {
          let line = `- /${cmd.name}: ${cmd.description}`
          if (cmd.subcommands) {
            const subs = cmd.subcommands.map((s) => s.name).join('|')
            line += ` (${subs})`
          }
          lines.push(line)
        }
        return lines.join('\n')
      },
    },
    // 工作流脚本格式提示：让模型知道工作流脚本是 JS 格式，放在 .c0de/workflows/。
    // js 骨架与 WORKFLOW_NOTICE（workflowz steering）同引 WORKFLOW_SCRIPT_TEMPLATE：
    // 两份手抄副本曾各自漂移（此处 meta 缺 argsHint/timeout、ctx 示例不同），
    // 两块同时进 system prompt 时模型按任一份生成都被判合法但产物形状不同。
    {
      id: 'workflow-format',
      content: '',
      priority: 121,
      render: () => {
        const lines = [
          '## Dynamic Workflows',
          'When the user asks to create/save a workflow (e.g. "workflowz 创建工作流"), you MUST generate a **JavaScript** file (NOT bash/shell/python) with this structure:',
          '```js',
          WORKFLOW_SCRIPT_TEMPLATE,
          '```',
          'Save to `<project>/.c0de/workflows/<name>.js`. Available subagent types: general, coder, researcher, reviewer.',
          'Run with `/workflow run <name>` or POST /api/workflows/:name/run. NEVER create bash/shell scripts for workflows.',
        ]
        return lines.join('\n')
      },
    },
  ]
}

// ── User override layer (.md files) ───────────────────────

const PROMPTS_DIRNAME = 'prompts'
/** Appended user sections sort after every built-in section
 *  (highest built-in priority: 121 = workflow-format). */
const APPEND_BASE_PRIORITY = 122

type PromptOverride = { id: string; body: string }

/** Read `<dir>/*.md` as { id: filename-minus-.md, body }. A missing or
 *  unreadable directory and unreadable files are skipped silently
 *  (best-effort layer, never blocks prompt assembly). */
function scanOverrideDir(dir: string): PromptOverride[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const overrides: PromptOverride[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    try {
      const body = readFileSync(join(dir, entry), 'utf8').trimEnd()
      overrides.push({ id: entry.slice(0, -'.md'.length), body })
    } catch {
      // one broken file never blocks the rest
    }
  }
  return overrides
}

/** User overrides visible for this build: global `<config-dir>/prompts` always,
 *  project `<cwd>/.c0de/prompts` only when the project is trusted (prompt text
 *  propagates via git clone and steers the model, so it is gated with the same
 *  fail-closed rule as project plugins/workflows). A project file with the same
 *  id wins over the global one; ids unknown to the registry are appended after
 *  the built-ins in filename (id) lexicographic order. */
function userOverrides(ctx: PromptBuildContext): PromptOverride[] {
  const layers = [scanOverrideDir(join(resolveGlobalConfigDir(), PROMPTS_DIRNAME))]
  if (ctx.cwd && ctx.projectTrusted) {
    layers.push(scanOverrideDir(join(ctx.cwd, '.c0de', PROMPTS_DIRNAME)))
  }
  const byId = new Map<string, PromptOverride>()
  for (const layer of layers) {
    for (const override of layer) byId.set(override.id, override)
  }
  return Array.from(byId.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Registry sections with the user .md layer applied last (after built-ins and
 *  plugin registrations). A file matching a section id replaces that section's
 *  body — the slot keeps its priority and condition, any `render` is dropped
 *  (render takes precedence over content, so it must go for the replacement to
 *  take effect); an empty file therefore removes the section. Unknown ids are
 *  appended as new sections after the built-ins. */
function sectionsWithOverrides(registry: PromptRegistry, ctx: PromptBuildContext): PromptSection[] {
  const overrides = userOverrides(ctx)
  if (overrides.length === 0) return Array.from(registry.sections.values())
  const sections = new Map(registry.sections)
  let priority = APPEND_BASE_PRIORITY
  for (const override of overrides) {
    const existing = sections.get(override.id)
    if (existing) {
      sections.set(override.id, { ...existing, content: override.body, render: undefined })
    } else {
      sections.set(override.id, { id: override.id, content: override.body, priority })
      priority += 1
    }
  }
  return Array.from(sections.values())
}

/** Create a registry pre-loaded with the built-in sections. */
function createPromptRegistry(): PromptRegistry {
  const registry: PromptRegistry = { sections: new Map() }
  for (const section of builtinSections()) {
    registry.sections.set(section.id, section)
  }
  return registry
}

/** Register a section. A later registration with the same id overrides the earlier
 *  one (lets plugins replace builtins). */
function registerPromptSection(registry: PromptRegistry, section: PromptSection): void {
  registry.sections.set(section.id, section)
}

/** Assemble the system prompt: filter by condition, sort by priority, render. */
function buildDynamicPrompt(registry: PromptRegistry, ctx: PromptBuildContext): string {
  const sections = sectionsWithOverrides(registry, ctx)
    .filter((s) => !s.condition || s.condition(ctx))
    .sort((a, b) => a.priority - b.priority)

  const parts: string[] = []
  for (const section of sections) {
    const body = section.render ? section.render(ctx) : section.content
    if (body.length > 0) parts.push(body)
  }
  return parts.join('\n\n')
}

export { buildDynamicPrompt, createPromptRegistry, registerPromptSection }
