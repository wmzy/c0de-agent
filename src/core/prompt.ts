import type { PromptContext } from './types.js'

const ROLE_DESCRIPTION = `You are c0de-agent, an open-source AI coding assistant.
You help developers write, debug, and understand code across multiple languages and frameworks.`

const PARADIGM_CONSTRAINTS = `## Coding Paradigm
This project follows a strict data + functions paradigm:
- Use \`type\` (not \`interface\`) for type definitions.
- Use discriminated unions with \`_tag\` fields for variant types.
- Use plain functions \`export function foo(ctx, ...)\` with context-first argument.
- No classes; prefer factory functions and pure data transformation.
- Prefer \`import type\` for type-only imports.`

const TOOL_USAGE = `## Tool Usage
You have dedicated tools — prefer them over shell commands for file operations:
- Reading a file or listing a directory → \`read\` (NOT \`cat\`, \`head\`, \`tail\`, \`less\`).
- Finding files by name or pattern → \`glob\` (NOT \`find\`, \`ls -R\`, \`fd\`).
- Searching file contents → \`grep\` (NOT shell \`grep\`/\`rg\`/\`ack\`, NOT \`awk\`/\`sed\`).
- Modifying files → \`edit\`/\`write\` (NOT \`sed\`, \`echo >\`, \`tee\`, heredocs).

Reserve \`bash\` for genuine command execution: builds, tests, git, or short pipelines that compute a fact (\`wc -l\`, \`git status\`, \`diff\`, a checksum). Never explore a codebase with \`find\`/\`ls\`/\`cat\` when \`read\`/\`glob\`/\`grep\` can do it — they are faster, safer, and skip ignored paths.`

function buildSystemPrompt(ctx: PromptContext): string {
  const parts: string[] = []
  parts.push(ROLE_DESCRIPTION)

  if (ctx.config.systemPrompt) {
    parts.push(ctx.config.systemPrompt)
  }

  if (ctx.tools.length > 0) {
    parts.push('## Available Tools')
    for (const tool of ctx.tools) {
      parts.push(`- **${tool.name}**: ${tool.description}`)
    }
    parts.push(TOOL_USAGE)
  }

  parts.push('## Project Context')
  parts.push(`- Name: ${ctx.projectInfo.name}`)
  parts.push(`- Language: ${ctx.projectInfo.language}`)
  if (ctx.projectInfo.framework) {
    parts.push(`- Framework: ${ctx.projectInfo.framework}`)
  }
  parts.push(`- Root: ${ctx.projectInfo.rootDir}`)
  if (ctx.projectInfo.gitBranch) {
    parts.push(`- Git Branch: ${ctx.projectInfo.gitBranch}`)
  }

  if (ctx.skills && ctx.skills.length > 0) {
    parts.push('## Loaded Skills')
    for (const skill of ctx.skills) {
      parts.push(`- ${skill}`)
    }
  }

  parts.push(PARADIGM_CONSTRAINTS)
  return parts.join('\n\n')
}

export { buildSystemPrompt }
