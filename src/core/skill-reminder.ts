// Category-based skill reminder (Oh-My-OpenAgent inspired).
//
// Detects what category a user message falls into based on keyword matching,
// then produces a reminder string that the agent loop can inject as a
// steering message so the LLM knows which skills/tools to prefer.
//
// Conventions: data + functions only.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkillCategory = {
  readonly name: string;
  readonly description: string;
  readonly keywords: readonly string[];
};

// ---------------------------------------------------------------------------
// Predefined categories
// ---------------------------------------------------------------------------

export const CATEGORIES: readonly SkillCategory[] = [
  {
    name: "testing",
    description: "Writing, running, or fixing tests (unit, integration, e2e).",
    keywords: [
      "test",
      "tests",
      "testing",
      "unit test",
      "integration test",
      "e2e",
      "vitest",
      "jest",
      "mocha",
      "playwright",
      "cypress",
      "pytest",
      "spec",
      "assertion",
      "coverage",
      "mock",
      "fixture",
    ],
  },
  {
    name: "debugging",
    description: "Diagnosing and fixing bugs or errors.",
    keywords: [
      "debug",
      "bug",
      "error",
      "fix",
      "crash",
      "broken",
      "stack trace",
      "exception",
      "regression",
      "issue",
      "failing",
      "fails",
      "not working",
      "TypeError",
      "ReferenceError",
    ],
  },
  {
    name: "refactoring",
    description: "Restructuring code without changing behavior.",
    keywords: [
      "refactor",
      "clean up",
      "cleanup",
      "reorganize",
      "simplify",
      "extract",
      "rename",
      "move",
      "consolidate",
      "deduplicate",
      "DRY",
    ],
  },
  {
    name: "performance",
    description: "Optimizing speed, memory, or resource usage.",
    keywords: [
      "performance",
      "slow",
      "optimize",
      "optimization",
      "cache",
      "speed",
      "latency",
      "memory",
      "throughput",
      "bottleneck",
      "profiling",
      "benchmark",
    ],
  },
  {
    name: "security",
    description: "Addressing security concerns, auth, and vulnerabilities.",
    keywords: [
      "security",
      "auth",
      "authentication",
      "authorization",
      "encrypt",
      "vulnerability",
      "xss",
      "sql injection",
      "csrf",
      "token",
      "jwt",
      "permission",
      "sanitiz",
    ],
  },
  {
    name: "documentation",
    description: "Writing or updating docs, comments, and READMEs.",
    keywords: [
      "documentation",
      "docs",
      "readme",
      "comment",
      "javadoc",
      "jsdoc",
      "typedoc",
      "changelog",
      "guide",
      "tutorial",
      "api reference",
    ],
  },
  {
    name: "architecture",
    description: "Designing system structure, patterns, and module boundaries.",
    keywords: [
      "architecture",
      "design",
      "pattern",
      "structure",
      "module",
      "abstraction",
      "interface",
      "dependency injection",
      "layer",
      "separation of concerns",
      "clean architecture",
      "microservice",
    ],
  },
  {
    name: "database",
    description: "Working with databases, schemas, migrations, and queries.",
    keywords: [
      "database",
      "db",
      "sql",
      "schema",
      "migration",
      "query",
      "index",
      "postgres",
      "mysql",
      "sqlite",
      "redis",
      "orm",
      "prisma",
      "drizzle",
      "knex",
    ],
  },
  {
    name: "ui",
    description: "Building or modifying user interfaces and styling.",
    keywords: [
      "ui",
      "ux",
      "frontend",
      "component",
      "layout",
      "css",
      "style",
      "styling",
      "tailwind",
      "design system",
      "responsive",
      "accessibility",
      "a11y",
      "button",
      "form",
      "modal",
      "dialog",
    ],
  },
  {
    name: "api",
    description: "Building or consuming APIs and network endpoints.",
    keywords: [
      "api",
      "endpoint",
      "rest",
      "graphql",
      "http",
      "request",
      "response",
      "webhook",
      "route",
      "middleware",
      "cors",
      "fetch",
      "axios",
      "openapi",
      "swagger",
    ],
  },
];

// ---------------------------------------------------------------------------
// detectCategory — keyword-based category detection
// ---------------------------------------------------------------------------

/**
 * Build a regex for a category from its keyword list.
 * Each keyword is escaped and wrapped in a word-boundary-aware pattern.
 */
function buildCategoryRegex(keywords: readonly string[]): RegExp {
  const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
}

/** Pre-built regexes for each category (computed once at module load). */
const CATEGORY_REGEXES: ReadonlyArray<{ category: SkillCategory; regex: RegExp }> =
  CATEGORIES.map((cat) => ({
    category: cat,
    regex: buildCategoryRegex(cat.keywords),
  }));

/**
 * Detect the primary category of a user message via keyword matching.
 *
 * Returns the first matching category (ordered by CATEGORIES), or null if
 * no keywords match. When multiple categories match, the first one in the
 * predefined list wins — callers should prefer the broadest category
 * rather than trying to return multiple.
 */
export function detectCategory(message: string): SkillCategory | null {
  const lower = message.toLowerCase();
  for (const { category, regex } of CATEGORY_REGEXES) {
    if (regex.test(lower)) {
      return category;
    }
  }
  return null;
}

/**
 * Detect ALL matching categories for a message, in priority order.
 * Useful when the agent wants to show multiple reminders.
 */
export function detectAllCategories(message: string): SkillCategory[] {
  const lower = message.toLowerCase();
  const matches: SkillCategory[] = [];
  for (const { category, regex } of CATEGORY_REGEXES) {
    if (regex.test(lower)) {
      matches.push(category);
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// getReminder — produce the reminder text for a category
// ---------------------------------------------------------------------------

/**
 * Map from category name to specific skill/tool recommendations.
 * These are domain-specific hints that guide the LLM toward relevant tools.
 */
const REMINDER_HINTS: Readonly<Record<string, readonly string[]>> = {
  testing: [
    "Use the `task` tool to delegate test-writing to a testing specialist subagent.",
    "Run tests with the `bash` tool to verify changes immediately.",
    "Prefer testing behavior over plumbing — test conditional branches, edge values, and error handling.",
  ],
  debugging: [
    "Use the `debug` tool for breakpoints and step-through when the issue is reproducible.",
    "Use the `search` tool to find related code before proposing a fix.",
    "Check error boundaries and stack traces with the `bash` tool.",
  ],
  refactoring: [
    "Use `ast_grep` and `ast_edit` for structural rewrites before text-based edits.",
    "Verify refactors compile — run `bash` with the project's build command.",
    "Reuse existing patterns; a second convention beside an existing one is PROHIBITED.",
  ],
  performance: [
    "Profile before optimizing — use `bash` to run benchmarks or profiling tools.",
    "Avoid premature abstraction; measure first, then optimize the hot path.",
    "Consider memory allocation: prefer in-place transforms over copies.",
  ],
  security: [
    "Audit input validation — use `search` to find all untrusted input paths.",
    "Never hardcode secrets; use environment variables or config files.",
    "Review authentication flows end-to-end before claiming them secure.",
  ],
  documentation: [
    "Write docs after code works — never present documentation as a deliverable before implementation.",
    "Use JSDoc/TSDoc for public APIs; keep internal comments sparse.",
    "Update README only when setup instructions or project structure changes.",
  ],
  architecture: [
    "Use the `plan` subagent for complex multi-file architectural decisions.",
    "Map dependencies before introducing new modules — avoid circular imports.",
    "Favor composition over inheritance; keep modules single-responsibility.",
  ],
  database: [
    "Use `ast_grep` to find all query sites before changing schemas.",
    "Write migrations as reversible operations when possible.",
    "Test queries against real data with the `bash` tool.",
  ],
  ui: [
    "Use `browser` tool to visually verify UI changes.",
    "Match existing design tokens and conventions in the project.",
    "Test responsive behavior at multiple viewport sizes.",
  ],
  api: [
    "Verify API contracts match client expectations — read both sides.",
    "Use proper error status codes and structured error responses.",
    "Test API endpoints end-to-end with the `bash` tool (curl/fetch).",
  ],
};

/**
 * Produce a reminder string for the given category.
 * The reminder includes the category name, description, and specific
 * tool/skill recommendations relevant to the category.
 */
export function getReminder(category: SkillCategory): string {
  const hints = REMINDER_HINTS[category.name] ?? [];
  const lines: string[] = [
    `[Skill Reminder — ${category.name}]`,
    category.description,
  ];
  if (hints.length > 0) {
    lines.push("Recommended approach:");
    for (const hint of hints) {
      lines.push(`  - ${hint}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// buildSkillReminders — convenience: detect + format all matching reminders
// ---------------------------------------------------------------------------

/**
 * Given a user message, detect all matching categories and produce a
 * combined reminder string. Returns an empty string when no categories match.
 *
 * This is the primary entry point for the agent loop: call it on the
 * incoming user message and inject the result as a steering message
 * when non-empty.
 */
export function buildSkillReminders(message: string): string {
  const categories = detectAllCategories(message);
  if (categories.length === 0) return "";
  return categories.map(getReminder).join("\n\n");
}
