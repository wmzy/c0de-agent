// Rules injector plugin — Oh-My-OpenAgent style rules injection (§7.5).
//
// Loads rule files from <projectDir>/.c0de/rules/ and injects matching rules
// as system messages into the message list before each provider call.
//
// Hook point: "message:before" (transforms the messages array before it's
// sent to the LLM).
//
// Conventions: data + functions, no class, no enum.
//
// Rule loading:
//   - Scans .c0de/rules/ for .md and .txt files.
//   - Optional YAML-style frontmatter between `---` delimiters for metadata
//     (name, scope, condition).
//   - Without frontmatter the filename (minus extension) is used as the name
//     and the full file content is treated as the rule body.
//
// Condition matching:
//   - filePath: glob-like pattern (simple * wildcard) matched against each
//     message that references a file path or the conversation context.
//   - language: matched against the detected programming language.
//   - No condition → always injected.

import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

// ---------------------------------------------------------------------------
// Rule
// ---------------------------------------------------------------------------

export type RuleCondition = {
  /** Glob-like file‑path pattern (e.g. "src/**\/*.ts"). A file‑message
   *  context or user message referencing a file path is matched against
   *  each pattern; if any match, the condition is satisfied. */
  filePath?: string[];
  /** Programming language name (e.g. "typescript", "python", "rust"). */
  language?: string[];
};

export type RuleScope = "always" | "conversation" | "codegen" | "debug";

export type Rule = {
  /** Unique rule name (derived from filename or frontmatter). */
  name: string;
  /** Rule content body — injected as a system message. */
  content: string;
  /** Optional condition for when this rule applies. */
  condition?: RuleCondition;
  /** Scope determines which agent phases the rule applies to. */
  scope?: RuleScope[];
};

// ---------------------------------------------------------------------------
// Frontmatter-parsed rule file
// ---------------------------------------------------------------------------

interface ParsedRuleFile {
  name: string;
  content: string;
  condition?: RuleCondition;
  scope?: RuleScope[];
}

// ---------------------------------------------------------------------------
// loadRules — read rules from <projectDir>/.c0de/rules/
//
// Scans the rules directory for supported file types (.md, .txt, .rule),
// parses optional frontmatter, and returns an array of Rule descriptors.
// Returns [] when the directory does not exist or is empty.
// ---------------------------------------------------------------------------

export async function loadRules(projectDir: string): Promise<Rule[]> {
  const rulesDir = join(projectDir, ".c0de", "rules");

  let entries: string[];
  try {
    entries = await readdir(rulesDir);
  } catch {
    // Directory does not exist — no rules to load.
    return [];
  }

  const rules: Rule[] = [];

  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (ext !== ".md" && ext !== ".txt" && ext !== ".rule") continue;

    const fullPath = join(rulesDir, entry);
    let raw: string;
    try {
      raw = await readFile(fullPath, "utf-8");
    } catch {
      continue;
    }

    const parsed = parseRuleFile(raw, entry);
    rules.push({
      name: parsed.name,
      content: parsed.content,
      condition: parsed.condition,
      scope: parsed.scope,
    });
  }

  return rules;
}

// ---------------------------------------------------------------------------
// parseRuleFile — extract frontmatter metadata + body from a rule file.
//
// Supports minimal YAML-style frontmatter between `---` fences:
//
//   ---
//   name: my-rule
//   condition:
//     filePath:
//       - "src/**"
//     language:
//       - typescript
//   scope:
//     - codegen
//   ---
//   Rule content goes here.
//
// Without frontmatter the filename stem is the rule name.
// ---------------------------------------------------------------------------

function parseRuleFile(raw: string, filename: string): ParsedRuleFile {
  const lines = raw.split("\n");
  if (lines.length < 2 || lines[0].trim() !== "---") {
    // No frontmatter — derive name from filename.
    return {
      name: basename(filename, extname(filename)),
      content: raw.trim(),
    };
  }

  // Find closing fence.
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    // Unclosed frontmatter — treat as content.
    return {
      name: basename(filename, extname(filename)),
      content: raw.trim(),
    };
  }

  const frontmatterLines = lines.slice(1, endIndex);
  const body = lines
    .slice(endIndex + 1)
    .join("\n")
    .trim();

  return parseFrontmatter(frontmatterLines, body, filename);
}

// ---------------------------------------------------------------------------
// parseFrontmatter — minimal frontmatter parser (key: value, lists under
// keys with leading `-`).
// ---------------------------------------------------------------------------

function parseFrontmatter(lines: string[], body: string, filename: string): ParsedRuleFile {
  const result: ParsedRuleFile = {
    name: basename(filename, extname(filename)),
    content: body || rawFallback(filename),
  };

  let currentKey: string | null = null;
  let currentSubKey: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // List item under a key: `  - value`
    if (trimmed.startsWith("- ")) {
      const value = trimmed.slice(2).trim();
      if (value.length === 0) continue;

      if (currentKey) {
        // Nested list under a sub-key, e.g. `condition.filePath`
        injectValue(result, currentKey, currentSubKey, value, true);
      }
      continue;
    }

    // Top-level key: `name: value` or nested `condition:` (sub-key next line)
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx !== -1) {
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();

      if (key === "name" && value) {
        result.name = value;
        currentKey = null;
        currentSubKey = null;
      } else if (key === "condition") {
        currentKey = "condition";
        currentSubKey = null;
      } else if (key === "scope") {
        currentKey = "scope";
        currentSubKey = null;
      } else if (currentKey === "condition" && value.length === 0) {
        // `condition:` followed by sub-keys on next lines
        currentSubKey = key;
      } else if (currentKey === "condition" && value) {
        // Simple `condition: value` (unlikely but handle)
        currentSubKey = key;
        injectValue(result, currentKey, key, value, false);
        currentSubKey = null;
      } else if (currentKey === "scope" && value) {
        injectValue(result, "scope", null, value, false);
        currentKey = null;
      } else if (currentKey) {
        currentSubKey = null;
      }
      continue;
    }

    // Empty line — reset nesting unless we're inside a named sub-key list
    if (trimmed.length === 0 && !currentSubKey) {
      currentKey = null;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// injectValue — mutate a ParsedRuleFile with a parsed key/value.
// ---------------------------------------------------------------------------

function injectValue(
  target: ParsedRuleFile,
  key: string,
  subKey: string | null,
  value: string,
  isListItem: boolean,
): void {
  if (key === "name" && !isListItem) {
    target.name = value;
    return;
  }

  if (key === "condition") {
    target.condition ??= {};
    if (subKey === "filePath" || subKey === "language") {
      target.condition[subKey] ??= [];
      if (isListItem || value) {
        target.condition[subKey]?.push(value);
      }
    }
    return;
  }

  if (key === "scope") {
    target.scope ??= [];
    const scopeVal = value as RuleScope;
    if (isValidScope(scopeVal) && !target.scope.includes(scopeVal)) {
      target.scope.push(scopeVal);
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// isValidScope — type guard for RuleScope.
// ---------------------------------------------------------------------------

function isValidScope(s: string): s is RuleScope {
  return s === "always" || s === "conversation" || s === "codegen" || s === "debug";
}

// ---------------------------------------------------------------------------
// rawFallback — minimal readable fallback when body is empty.
// ---------------------------------------------------------------------------

function rawFallback(filename: string): string {
  return `Rule: ${basename(filename, extname(filename))}`;
}

// ---------------------------------------------------------------------------
// injectRules — prepend matching rules as system messages.
//
// For each rule:
//   1. Check scope — no scope or matching scope → proceed.
//   2. Check condition — no condition or condition matches context → proceed.
//   3. Prepend a system message with the rule content.
//
// Returns a new array leaving the original untouched.
// ---------------------------------------------------------------------------

export function injectRules(
  messages: MessageLike[],
  rules: Rule[],
  context?: InjectContext,
): MessageLike[] {
  if (rules.length === 0) return messages;

  const ctx = context ?? inferContext(messages);

  // Filter and sort: unconditional rules first, then by name for determinism.
  const matched = rules
    .filter((rule) => scopeMatches(rule, ctx))
    .filter((rule) => conditionMatches(rule, ctx))
    .sort((a, b) => {
      // Unconditional rules before conditional ones.
      const aCond = a.condition ? 1 : 0;
      const bCond = b.condition ? 1 : 0;
      if (aCond !== bCond) return aCond - bCond;
      return a.name.localeCompare(b.name);
    });

  if (matched.length === 0) return messages;

  const systemMessages: MessageLike[] = matched.map((rule) => ({
    role: "system" as const,
    content: rule.content,
    name: `rule:${rule.name}`,
  }));

  return [...systemMessages, ...messages];
}

// ---------------------------------------------------------------------------
// InjectContext — contextual information for condition evaluation.
// ---------------------------------------------------------------------------

export type InjectContext = {
  /** File paths relevant to the current conversation context. */
  filePaths: string[];
  /** Programming languages detected in the conversation. */
  languages: string[];
  /** Current agent phase / activity scope. */
  currentScope?: RuleScope;
};

// ---------------------------------------------------------------------------
// inferContext — build an InjectContext from the current messages.
//
// Scans user and system messages for file path references (strings
// containing "." or "/") and language clues (common code block info strings).
// ---------------------------------------------------------------------------

function inferContext(messages: MessageLike[]): InjectContext {
  const filePaths: string[] = [];
  const languages: Set<string> = new Set();

  const filePattern = /(?:\b(?:path|file|in)\s*[:=]\s*)?([\w./\\-]+\.[a-z]+)/gi;
  const langPattern = /```(\w+)/g;
  const fenceLangPattern = /language[:\s]+(\w+)/gi;

  for (const msg of messages) {
    const text = typeof msg.content === "string" ? msg.content : "";

    // File path lookahead
    filePattern.lastIndex = 0;
    const fileMatches = text.matchAll(filePattern);
    for (const match of fileMatches) {
      const p = match[1].trim();
      if (p.length > 0 && p.length < 200) {
        filePaths.push(p);
      }
    }

    // Language detection from fenced code blocks
    langPattern.lastIndex = 0;
    const langMatches = text.matchAll(langPattern);
    for (const match of langMatches) {
      languages.add(match[1].toLowerCase());
    }

    // Explicit language hints
    fenceLangPattern.lastIndex = 0;
    const fenceMatches = text.matchAll(fenceLangPattern);
    for (const match of fenceMatches) {
      languages.add(match[1].toLowerCase());
    }
  }

  return { filePaths, languages: Array.from(languages) };
}

// ---------------------------------------------------------------------------
// scopeMatches — check if a rule's scope constraints match the context.
// ---------------------------------------------------------------------------

function scopeMatches(rule: Rule, ctx: InjectContext): boolean {
  if (!rule.scope || rule.scope.length === 0) return true;
  if (!ctx.currentScope) return true;
  return rule.scope.includes(ctx.currentScope);
}

// ---------------------------------------------------------------------------
// conditionMatches — evaluate a rule's condition against the context.
//
// - filePath: any file path in context that matches any pattern → true.
// - language: any language in context matching any listed language → true.
// - No condition → always true.
// - Multiple condition keys: ALL must match (implicit AND).
// ---------------------------------------------------------------------------

function conditionMatches(rule: Rule, ctx: InjectContext): boolean {
  if (!rule.condition) return true;

  const cond = rule.condition;

  // File path matching
  if (cond.filePath && cond.filePath.length > 0) {
    const fileMatch = cond.filePath.some((pattern) =>
      ctx.filePaths.some((fp) => matchGlob(pattern, fp)),
    );
    if (!fileMatch) return false;
  }

  // Language matching
  if (cond.language && cond.language.length > 0) {
    const langLower = cond.language.map((l) => l.toLowerCase());
    const langMatch = langLower.some((l) => ctx.languages.includes(l));
    if (!langMatch) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// matchGlob — simple glob matching (supports * and ** wildcards).
//
// Converts a glob pattern to a regex. Supports:
//   - `*` matches any non-separator characters within a segment
//   - `**` matches any characters including separators
// ---------------------------------------------------------------------------

function matchGlob(pattern: string, filepath: string): boolean {
  if (pattern === "*" || pattern === "**/*") return true;

  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "@@DOUBLESTAR@@")
    .replace(/\*/g, "[^/]*")
    .replace(/@@DOUBLESTAR@@/g, ".*");

  try {
    return new RegExp(`^${escaped}$`).test(filepath);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// MessageLike — minimal message shape required for injection.
//
// Rules injector works at the "message:before" hook boundary where messages
// are the core.Message[] shape. We accept any structurally compatible
// message to avoid a hard dependency on core types at the plugin level.
// ---------------------------------------------------------------------------

export type MessageLike = {
  role: string;
  content: string | unknown[];
  name?: string;
  toolCallId?: string;
  toolCalls?: unknown[];
  createdAt?: number;
};
