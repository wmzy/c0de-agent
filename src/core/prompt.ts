// Dynamic system prompt construction (per design spec §3.4 and §17).
//
// Sections are registered into a PromptRegistry; buildSystemPrompt evaluates
// each section's `condition` against the build context, sorts surviving
// sections by `priority` (ascending — lower priority renders earlier), and
// joins them with a separator.

import type {
  AgentConfig,
  PromptBuildContext,
  PromptContext,
  PromptRegistry,
  PromptSection,
  Skill,
  ToolDef,
} from "./types";

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

export function createPromptRegistry(): PromptRegistry {
  return { sections: [] };
}

export function registerPromptSection(registry: PromptRegistry, section: PromptSection): void {
  // Replace by id if present, append otherwise — keeps registry idempotent.
  const idx = registry.sections.findIndex((s) => s.id === section.id);
  if (idx >= 0) {
    registry.sections[idx] = section;
  } else {
    registry.sections.push(section);
  }
}

export function unregisterPromptSection(registry: PromptRegistry, id: string): boolean {
  const idx = registry.sections.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  registry.sections.splice(idx, 1);
  return true;
}

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

export function buildSystemPrompt(ctx: PromptContext): string {
  const registry = defaultPromptRegistry();
  return buildSystemPromptFromRegistry(registry, ctx);
}

export function buildSystemPromptFromRegistry(
  registry: PromptRegistry,
  ctx: PromptBuildContext,
): string {
  const visible = registry.sections
    .filter((section) => (section.condition ? section.condition(ctx) : true))
    .slice()
    .sort((a, b) => a.priority - b.priority);

  const blocks: string[] = [];
  for (const section of visible) {
    const body = section.content.trim();
    if (body.length === 0) continue;
    blocks.push(`## ${section.title}\n\n${body}`);
  }
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Built-in sections (per spec §17.2)
// ---------------------------------------------------------------------------

export const ROLE_SECTION_ID = "role";
export const TOOLS_SECTION_ID = "tools";
export const SKILLS_SECTION_ID = "skills";
export const AGENTS_SECTION_ID = "agents";
export const PROJECT_SECTION_ID = "project";
export const CONSTRAINTS_SECTION_ID = "constraints";
export const SLASH_COMMANDS_SECTION_ID = "slash-commands";

export const ROLE_PRIORITY = 10;
export const CONSTRAINTS_PRIORITY = 20;
export const TOOLS_PRIORITY = 30;
export const SKILLS_PRIORITY = 40;
export const AGENTS_PRIORITY = 50;
export const PROJECT_PRIORITY = 60;
export const SLASH_COMMANDS_PRIORITY = 70;

const ROLE_CONTENT = `You are c0de-agent, an AI coding assistant. Help the user with software development tasks across planning, implementation, debugging, and review.

Operating principles:
- Prefer the smallest change that solves the problem.
- Use tools when the answer requires current or external information; never fabricate file contents or command output.
- Verify before claiming success — read what you wrote, run what you changed.
- Keep responses concise; let tool output carry the substance.`;

const CONSTRAINTS_CONTENT = `Coding paradigm (data + functions):
- All code uses type declarations and export functions. No class, no new, no this, no obj.method().
- Variants are discriminated unions with a \`_tag\` field; dispatch via switch on \`_tag\`, never via instanceof.
- Constructors are \`create*\` / \`make*\` factory functions; invariants live inside the factory, not the caller.
- State changes flow through functions that accept context as the first argument.
- When reading or editing, match the conventions already in the file — never introduce a second style alongside an existing one.`;

const SLASH_COMMANDS_CONTENT = `Available slash commands (call via the \`slash-command\` tool or the CLI):
- \`/compact\` — manually trigger context compaction.
- \`/model <name>\` — switch the current session model.
- \`/clear\` — clear current session messages.
- \`/help\` — list available commands.
- \`/fork [messageIndex]\` — branch the session at the given message index.
- \`/config <key> [value]\` — view or set a configuration value.`;

export function defaultPromptRegistry(): PromptRegistry {
  const registry = createPromptRegistry();
  registerPromptSection(registry, {
    id: ROLE_SECTION_ID,
    title: "Role",
    content: ROLE_CONTENT,
    priority: ROLE_PRIORITY,
  });
  registerPromptSection(registry, {
    id: CONSTRAINTS_SECTION_ID,
    title: "Coding constraints",
    content: CONSTRAINTS_CONTENT,
    priority: CONSTRAINTS_PRIORITY,
    // Spec §17.2: always shown.
  });
  registerPromptSection(registry, {
    id: TOOLS_SECTION_ID,
    title: "Available tools",
    content: "",
    priority: TOOLS_PRIORITY,
    condition: (ctx) => ctx.tools.length > 0,
  });
  registerPromptSection(registry, {
    id: SKILLS_SECTION_ID,
    title: "Loaded skills",
    content: "",
    priority: SKILLS_PRIORITY,
    condition: (ctx) => ctx.skills.length > 0,
  });
  registerPromptSection(registry, {
    id: AGENTS_SECTION_ID,
    title: "Available sub-agents",
    content: "",
    priority: AGENTS_PRIORITY,
    condition: (ctx) => ctx.agents.length > 0,
  });
  registerPromptSection(registry, {
    id: PROJECT_SECTION_ID,
    title: "Project context",
    content: "",
    priority: PROJECT_PRIORITY,
    condition: (ctx) => ctx.projectInfo !== undefined && ctx.projectInfo !== null,
  });
  registerPromptSection(registry, {
    id: SLASH_COMMANDS_SECTION_ID,
    title: "Slash commands",
    content: SLASH_COMMANDS_CONTENT,
    priority: SLASH_COMMANDS_PRIORITY,
  });
  // Fill the content of conditional sections now that the registry exists.
  fillToolsSection(registry);
  fillSkillsSection(registry);
  fillAgentsSection(registry);
  fillProjectSection(registry);
  return registry;
}

// ---------------------------------------------------------------------------
// Section renderers — pure functions of the build context that produce the
// content strings for the conditional sections.
// ---------------------------------------------------------------------------

export function renderToolsSection(tools: ToolDef[]): string {
  if (tools.length === 0) return "";
  const lines: string[] = ["You have access to the following tools:"];
  for (const tool of tools) {
    lines.push(`### \`${tool.name}\` (permission: ${tool.permission})`);
    lines.push(tool.description);
    lines.push("Parameters (JSON Schema):");
    lines.push("```json");
    lines.push(JSON.stringify(tool.parameters, null, 2));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function renderSkillsSection(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines: string[] = ["The following skills are loaded for this session:"];
  for (const skill of skills) {
    if (!skill.enabled) continue;
    lines.push(`### ${skill.name}`);
    lines.push(skill.description);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function renderAgentsSection(agents: { name: string; description: string }[]): string {
  if (agents.length === 0) return "";
  const lines: string[] = ["You can delegate to the following sub-agents (via the `task` tool):"];
  for (const agent of agents) {
    lines.push(`- \`${agent.name}\` — ${agent.description}`);
  }
  return lines.join("\n").trim();
}

export function renderProjectSection(
  project: PromptBuildContext["projectInfo"] | undefined,
): string {
  if (!project) return "";
  const lines: string[] = [];
  lines.push(`Working directory: \`${project.rootDir}\``);
  if (project.name) lines.push(`Project name: ${project.name}`);
  if (project.language) lines.push(`Primary language: ${project.language}`);
  if (project.packageManager && project.packageManager !== "unknown") {
    lines.push(`Package manager: ${project.packageManager}`);
  }
  if (typeof project.fileCount === "number") {
    lines.push(`File count: ${project.fileCount}`);
  }
  if (project.gitBranch) {
    lines.push(`Git branch: ${project.gitBranch}`);
    if (project.gitStatus && project.gitStatus !== "unknown") {
      lines.push(`Git status: ${project.gitStatus}`);
    }
  }
  if (project.dependencies && project.dependencies.length > 0) {
    lines.push(`Notable dependencies: ${project.dependencies.slice(0, 12).join(", ")}`);
  }
  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function fillToolsSection(registry: PromptRegistry): void {
  const section = registry.sections.find((s) => s.id === TOOLS_SECTION_ID);
  if (!section) return;
  // Render happens at build time via condition+content substitution;
  // here we leave content empty and let buildSystemPromptFromRegistry
  // augment it. (See resolveSectionContent.)
}

function fillSkillsSection(registry: PromptRegistry): void {
  const section = registry.sections.find((s) => s.id === SKILLS_SECTION_ID);
  if (!section) return;
}

function fillAgentsSection(registry: PromptRegistry): void {
  const section = registry.sections.find((s) => s.id === AGENTS_SECTION_ID);
  if (!section) return;
}

function fillProjectSection(registry: PromptRegistry): void {
  const section = registry.sections.find((s) => s.id === PROJECT_SECTION_ID);
  if (!section) return;
}

// ---------------------------------------------------------------------------
// resolveSectionContent — produces the final content for a section, combining
// the registry's static content with dynamic renderers for the four
// context-driven sections. Exported so callers can preview a single section
// without re-running the full prompt build.
// ---------------------------------------------------------------------------

export function resolveSectionContent(section: PromptSection, ctx: PromptBuildContext): string {
  const base = section.content.trim();
  switch (section.id) {
    case TOOLS_SECTION_ID: {
      const dyn = renderToolsSection(ctx.tools);
      return [base, dyn].filter((s) => s.length > 0).join("\n\n");
    }
    case SKILLS_SECTION_ID: {
      const dyn = renderSkillsSection(ctx.skills);
      return [base, dyn].filter((s) => s.length > 0).join("\n\n");
    }
    case AGENTS_SECTION_ID: {
      const dyn = renderAgentsSection(ctx.agents);
      return [base, dyn].filter((s) => s.length > 0).join("\n\n");
    }
    case PROJECT_SECTION_ID: {
      const dyn = renderProjectSection(ctx.projectInfo);
      return [base, dyn].filter((s) => s.length > 0).join("\n\n");
    }
    default:
      return base;
  }
}

// ---------------------------------------------------------------------------
// Re-export so callers don't need to reach into ./types for the common shape.
// ---------------------------------------------------------------------------

export type { PromptContext, PromptSection };
export type { AgentConfig };
