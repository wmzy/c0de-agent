// System prompt construction (spec §3.4).
//
// Builds the full system prompt from the agent's runtime context:
//   - Base role description
//   - Tool list with parameter schemas
//   - Project context (language, package manager, git, etc.)
//   - Skill descriptions
//   - Coding paradigm constraints
//
// Conventions: data + functions, no class.

import type { ToolDef } from "../core/types";
import type { Message, ProjectInfo, Skill } from "../core/types";
import type { ChatMessage } from "../llm";

// ---------------------------------------------------------------------------
// DEFAULT_SYSTEM_PROMPT — the base role description
// ---------------------------------------------------------------------------

export const DEFAULT_SYSTEM_PROMPT = `You are c0de-agent, an AI coding assistant. You help users with software development tasks.

## Core Principles

- Write correct, maintainable code. Prefer correctness over cleverness.
- Reuse existing patterns in the codebase. Never introduce a second convention beside an existing one.
- Fix problems at the source — do not suppress warnings or special-case inputs unless explicitly asked.
- Remove obsolete code. No leftover comments, aliases, or re-exports.
- Search instead of guessing. Never assume a file path, API shape, or library behavior.

## Coding Paradigm

This project uses a strict **data + functions** paradigm:

- **No classes, no \`new\`, no \`this\`, no \`obj.method()\`**. Every composite shape is declared with \`type\`, never \`interface\`.
- Variants are tagged via a \`_tag\` field and dispatched via \`switch\` on \`_tag\`.
- State is a plain data object created by a factory function (e.g. \`createAgent(config): AgentState\`).
- Behavior is a set of exported functions that take the data object as their first argument.
- Prefer immutable patterns: return new objects rather than mutating arguments.

## Tool Usage

When using tools:
- Always verify file contents before editing — read the section you plan to change.
- Run tests after making changes to verify correctness.
- Be precise with file paths — use the \`find\` or \`search\` tool to locate files first.
- Prefer narrow lookups (\`search\`/ \`find\`) over full-file reads.
- Use syntax-aware tools (\`ast_grep\`, \`ast_edit\`) before text-based hacks.
- Explain what you are doing and why, briefly.

## Workflow

1. Understand the request before acting. Read relevant code and specs first.
2. Plan multi-file work before touching files.
3. Implement with surgical precision — edit, don't rewrite blindly.
4. Verify: run the specific test, command, or scenario that covers your change.
5. Never claim work is complete without evidence.

Be concise, helpful, and focused on the task.`;

// ---------------------------------------------------------------------------
// buildSystemPrompt — assemble the full system prompt from context
// ---------------------------------------------------------------------------

export function buildSystemPrompt(opts: {
  systemPrompt?: string;
  tools: ToolDef[];
  skills?: Skill[];
  projectInfo?: ProjectInfo;
}): string {
  const sections: string[] = [];

  // 1. Base prompt
  sections.push(opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);

  // 2. Coding paradigm enforcement (always included)
  sections.push(`## Coding Paradigm (Mandatory)

All code you write or modify MUST follow the data + functions paradigm:
- Use \`type\` for all composite shapes. Never use \`interface\` or \`class\`.
- Tagged unions use \`_tag\` field. Dispatch with \`switch\` on \`_tag\`.
- Factory functions (e.g. \`createXxx\`) return plain data objects.
- Functions take data as first argument: \`function doThing(state: State, ...)\`.
- No \`this\`, no \`new\`, no method syntax on data types.`);

  // 3. Tool descriptions
  if (opts.tools.length > 0) {
    const toolList = opts.tools
      .map((t) => {
        const schema = t.parameters;
        const props =
          schema && typeof schema === "object" && schema.type === "object" && "properties" in schema
            ? schema.properties
            : undefined;
        const params = props
          ? Object.entries(props)
              .map(([k, v]) => {
                const desc =
                  typeof v === "object" && v !== null && "description" in v
                    ? (v as Record<string, unknown>).description
                    : undefined;
                return desc ? `    - ${k}: ${desc}` : `    - ${k}`;
              })
              .join("\n")
          : "    (no parameters)";
        return `### ${t.name}\n${t.description}\n  Parameters:\n${params}`;
      })
      .join("\n\n");

    sections.push(`## Available Tools\n\n${toolList}`);
  }

  // 4. Project info
  if (opts.projectInfo) {
    const info = opts.projectInfo;
    const parts: string[] = [];
    if (info.name) parts.push(`Project: ${info.name}`);
    if (info.language) parts.push(`Language: ${info.language}`);
    if (info.packageManager && info.packageManager !== "unknown") {
      parts.push(`Package manager: ${info.packageManager}`);
    }
    if (info.gitBranch) parts.push(`Git branch: ${info.gitBranch}`);
    if (info.gitStatus && info.gitStatus !== "unknown") {
      parts.push(`Working tree: ${info.gitStatus}`);
    }
    if (info.dependencies && info.dependencies.length > 0) {
      parts.push(`Key dependencies: ${info.dependencies.slice(0, 20).join(", ")}`);
    }
    if (parts.length > 0) {
      sections.push(`## Project Context\n\n${parts.join("\n")}`);
    }
  }

  // 5. Skills
  if (opts.skills && opts.skills.length > 0) {
    const skillList = opts.skills
      .filter((s) => s.enabled)
      .map((s) => `- **${s.name}**: ${s.description}`)
      .join("\n");
    if (skillList) {
      sections.push(`## Available Skills\n\n${skillList}`);
    }
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// convertMessageToChatMessage — bridge between session-level Message and
// wire-format ChatMessage used by the LLM providers.
// ---------------------------------------------------------------------------

export function convertMessageToChatMessage(msg: Message): ChatMessage {
  // Handle content conversion
  let content: string;
  if (typeof msg.content === "string") {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    // Flatten content parts to text for now. Rich content (images, refs)
    // will need proper ContentPart mapping in a future pass.
    content = msg.content
      .map((part) => {
        switch (part._tag) {
          case "text":
            return part.text;
          case "image":
            return `[image: ${part.alt ?? part.url}]`;
          case "reference":
            return `[reference: ${part.path}:${part.startLine}-${part.endLine}]`;
          default:
            return "";
        }
      })
      .join("\n");
  } else {
    content = "";
  }

  return {
    role: msg.role,
    content,
    ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
    ...(msg.toolCalls
      ? {
          toolCalls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          })),
        }
      : {}),
    ...(msg.name ? { name: msg.name } : {}),
  };
}
