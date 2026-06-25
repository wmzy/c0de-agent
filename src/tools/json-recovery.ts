// JSON error recovery for tool inputs (§5.3 integration).
//
// LLMs frequently emit malformed JSON in tool call arguments:
// trailing commas, unquoted keys, single quotes, comments, markdown
// fences, etc. This module provides a layered recovery pipeline:
//
//   1. detectJsonErrors(raw)  — parse attempt + error classification
//   2. tryFixJson(raw)        — apply fixers in priority order, re-parse
//   3. recoverToolInput(raw)  — high-level: try parse → fix → re-parse
//
// Conventions: data + functions only, no class. Tagged unions via `_tag`.
// Fixers are pure functions: string → string (best-effort).

// ---------------------------------------------------------------------------
// Error detection types
// ---------------------------------------------------------------------------

export type JsonErrorKind =
  | "trailing_comma"
  | "unquoted_key"
  | "single_quotes"
  | "unquoted_string_value"
  | "line_comment"
  | "block_comment"
  | "js_literal"
  | "markdown_fence"
  | "extra_trailing_text"
  | "missing_bracket"
  | "unknown";

export type JsonErrorDetail = {
  _tag: "json_error";
  kind: JsonErrorKind;
  message: string;
  position?: number;
};

export type JsonOk = {
  _tag: "json_ok";
  value: unknown;
};

export type JsonDetection = JsonErrorDetail | JsonOk;

// ---------------------------------------------------------------------------
// Recovery types
// ---------------------------------------------------------------------------

export type JsonRecoveryFixer = {
  name: string;
  description: string;
  apply: (raw: string) => string;
};

export type JsonRecoverySuccess = {
  _tag: "recovered";
  value: unknown;
  fixes: string[];
};

export type JsonRecoveryFailure = {
  _tag: "unrecoverable";
  original: JsonErrorDetail;
  attemptedFixes: string[];
};

export type JsonRecoveryResult = JsonRecoverySuccess | JsonRecoveryFailure;

// ---------------------------------------------------------------------------
// Error position extraction
// ---------------------------------------------------------------------------

/**
 * Extract the byte position from a native JSON.parse SyntaxError message.
 * Returns undefined if the message doesn't contain a position.
 */
function extractPosition(message: string): number | undefined {
  // V8: "Unexpected token } in JSON at position 12"
  const v8 = message.match(/at position (\d+)/);
  if (v8) return Number.parseInt(v8[1], 10);
  // SpiderMonkey: "JSON.parse: expected property value at line 1 column 5"
  const sm = message.match(/column (\d+)/);
  if (sm) return Number.parseInt(sm[1], 10);
  return undefined;
}

// ---------------------------------------------------------------------------
// Error detection
// ---------------------------------------------------------------------------

/**
 * Classify a JSON.parse error into one of the known kinds.
 * Uses heuristics on the raw string rather than the error message alone,
 * because error messages vary across JS engines.
 */
function classifyError(raw: string, err: Error): JsonErrorKind {
  const msg = err.message.toLowerCase();
  const trimmed = raw.trim();

  // Markdown code fences: ```json\n{...}\n```
  if (/^```/.test(trimmed) || /```$/.test(trimmed)) {
    return "markdown_fence";
  }

  // Trailing comma: ,} or ,]
  if (/,\s*[}\]]/.test(trimmed)) {
    return "trailing_comma";
  }

  // Line comments: // ...
  if (/\/\//.test(trimmed)) {
    return "line_comment";
  }

  // Block comments: /* ... */
  if (/\/\*[\s\S]*?\*\//.test(trimmed)) {
    return "block_comment";
  }

  // Single quotes as string delimiters (not apostrophes in values)
  if (/^\s*['{]/.test(trimmed) && /['"]/.test(trimmed)) {
    // Check if we see patterns like {'key': value} which suggest single-quote JSON
    const singleQuoteKeys = /['"][\w$_]+['"]\s*:/.test(trimmed);
    const doubleQuoteKeys = /"[\w$_]+"\s*:/.test(trimmed);
    if (singleQuoteKeys && !doubleQuoteKeys) {
      return "single_quotes";
    }
  }

  // Unquoted keys: patterns like { key: "value" } or { key: 123 }
  if (/\{\s*[\w$_]+\s*:/.test(trimmed) && !/^\s*\{?\s*"/.test(trimmed)) {
    return "unquoted_key";
  }

  // JS literals: undefined, NaN, Infinity
  if (/\b(?:undefined|NaN|Infinity)\b/.test(trimmed)) {
    return "js_literal";
  }

  // Unquoted string values: {"key": value_without_quotes}
  if (/"[\w$_]+"\s*:\s*[a-zA-Z_$][\w$_]*\s*[},]/.test(trimmed)) {
    return "unquoted_string_value";
  }

  // Missing bracket — check for unmatched braces/brackets
  let braces = 0;
  let brackets = 0;
  let inString = false;
  let escape = false;
  for (const ch of trimmed) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") braces++;
    if (ch === "}") braces--;
    if (ch === "[") brackets++;
    if (ch === "]") brackets--;
  }
  if (braces > 0 || brackets > 0) {
    return "missing_bracket";
  }

  return "unknown";
}

/**
 * Attempt to parse raw text as JSON. Returns a detection result indicating
 * success or classifying the error.
 */
export function detectJsonErrors(raw: string): JsonDetection {
  try {
    const value = JSON.parse(raw);
    return { _tag: "json_ok", value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = classifyError(raw, err instanceof Error ? err : new Error(message));
    const position = extractPosition(message);
    return { _tag: "json_error", kind, message, position };
  }
}

// ---------------------------------------------------------------------------
// Fixer implementations
// ---------------------------------------------------------------------------

/**
 * Strip markdown code fences (```json ... ``` or ``` ... ```).
 */
const stripMarkdownFences: JsonRecoveryFixer = {
  name: "strip_markdown_fences",
  description: "Remove markdown code fences wrapping JSON",
  apply(raw: string): string {
    let s = raw.trim();
    // Opening fence
    s = s.replace(/^```(?:json)?\s*\n?/i, "");
    // Closing fence
    s = s.replace(/\n?```\s*$/i, "");
    return s.trim();
  },
};

/**
 * Strip leading/trailing non-JSON text (LLMs sometimes prefix/suffix JSON
 * with prose like "Here is the JSON:" or "```json\n{...}\n```").
 */
const stripSurroundingText: JsonRecoveryFixer = {
  name: "strip_surrounding_text",
  description: "Extract JSON object/array from surrounding prose",
  apply(raw: string): string {
    const s = raw.trim();
    // Find the first { or [ that starts a JSON structure
    const start = s.search(/[\[{]/);
    if (start === -1) return s;
    // Find the last } or ] that closes it
    const end = s.lastIndexOf("}");
    const endBracket = s.lastIndexOf("]");
    const lastClose = Math.max(end, endBracket);
    if (lastClose <= start) return s;
    return s.slice(start, lastClose + 1);
  },
};

/**
 * Remove single-line comments (// ...) and block comments (/* ... *​/).
 */
const removeComments: JsonRecoveryFixer = {
  name: "remove_comments",
  description: "Strip // and /* */ comments from JSON",
  apply(raw: string): string {
    let result = "";
    let inString = false;
    let escape = false;
    let i = 0;

    while (i < raw.length) {
      const ch = raw[i]!;
      const next = raw[i + 1];

      if (escape) {
        result += ch;
        escape = false;
        i++;
        continue;
      }

      if (inString) {
        if (ch === "\\") {
          escape = true;
          result += ch;
          i++;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        result += ch;
        i++;
        continue;
      }

      // Not in string — check for comment starts
      if (ch === "/" && next === "/") {
        // Line comment — skip until newline
        while (i < raw.length && raw[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        // Block comment — skip until */
        i += 2;
        while (i < raw.length - 1) {
          if (raw[i] === "*" && raw[i + 1] === "/") {
            i += 2;
            break;
          }
          i++;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      }

      result += ch;
      i++;
    }

    return result;
  },
};

/**
 * Remove trailing commas before } or ].
 */
const removeTrailingCommas: JsonRecoveryFixer = {
  name: "remove_trailing_commas",
  description: "Remove trailing commas before } or ]",
  apply(raw: string): string {
    let result = "";
    let inString = false;
    let escape = false;

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      const next = raw[i + 1];

      if (escape) {
        result += ch;
        escape = false;
        continue;
      }

      if (inString) {
        if (ch === "\\") escape = true;
        if (ch === '"') inString = false;
        result += ch;
        continue;
      }

      if (ch === '"') {
        inString = true;
        result += ch;
        continue;
      }

      // Skip comma if followed by } or ] (with optional whitespace/newlines)
      if (ch === "," && next !== undefined) {
        const rest = raw.slice(i + 1);
        if (/^\s*[}\]]/.test(rest)) {
          continue;
        }
      }

      result += ch;
    }

    return result;
  },
};

/**
 * Quote unquoted object keys: { key: ... } → { "key": ... }
 */
const quoteUnquotedKeys: JsonRecoveryFixer = {
  name: "quote_unquoted_keys",
  description: "Add double quotes around unquoted object keys",
  apply(raw: string): string {
    // Match word-chars as keys before a colon, outside strings
    // Use a stateful scan to avoid replacing keys inside strings
    let result = "";
    let inString = false;
    let escape = false;

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;

      if (escape) {
        result += ch;
        escape = false;
        continue;
      }

      if (inString) {
        if (ch === "\\") escape = true;
        if (ch === '"') inString = false;
        result += ch;
        continue;
      }

      if (ch === '"') {
        inString = true;
        result += ch;
        continue;
      }

      // Look for an unquoted key: word-chars followed by optional whitespace and colon
      if (/[\w$_]/.test(ch)) {
        const match = raw.slice(i).match(/^([\w$_]+)\s*:/);
        if (match) {
          const key = match[1]!;
          result += `"${key}"`;
          i += key.length - 1; // -1 because loop increments
          continue;
        }
      }

      result += ch;
    }

    return result;
  },
};

/**
 * Replace single quotes with double quotes (simple heuristic).
 * Only replaces quotes that appear to be string delimiters around keys/values.
 */
const replaceSingleQuotes: JsonRecoveryFixer = {
  name: "replace_single_quotes",
  description: "Convert single-quoted strings to double-quoted",
  apply(raw: string): string {
    // First, remove JS-style comments so we don't mess up edge cases
    let s = removeComments.apply(raw);

    // Replace single-quoted strings with double-quoted ones.
    // This is deliberately simple: we look for single-quoted spans and
    // replace them, escaping any inner double-quotes.
    let result = "";
    let i = 0;

    while (i < s.length) {
      if (s[i] === "'") {
        // Find the closing single quote
        let j = i + 1;
        let escaped = false;
        while (j < s.length) {
          if (escaped) {
            escaped = false;
            j++;
            continue;
          }
          if (s[j] === "\\") {
            escaped = true;
            j++;
            continue;
          }
          if (s[j] === "'") break;
          j++;
        }

        if (j < s.length) {
          // Extract the inner content (between quotes)
          const inner = s.slice(i + 1, j);
          // Escape any existing double-quotes in the content
          const escaped = inner.replace(/"/g, '\\"');
          result += `"${escaped}"`;
          i = j + 1;
          continue;
        }
      }

      result += s[i]!;
      i++;
    }

    return result;
  },
};

/**
 * Replace JS literals (undefined, NaN, Infinity) with JSON equivalents.
 */
const replaceJsLiterals: JsonRecoveryFixer = {
  name: "replace_js_literals",
  description: "Replace undefined→null, NaN→null, Infinity→null",
  apply(raw: string): string {
    // Only replace outside of strings
    let result = "";
    let inString = false;
    let escape = false;

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;

      if (escape) {
        result += ch;
        escape = false;
        continue;
      }

      if (inString) {
        if (ch === "\\") escape = true;
        if (ch === '"') inString = false;
        result += ch;
        continue;
      }

      if (ch === '"') {
        inString = true;
        result += ch;
        continue;
      }

      // Check for JS literals at this position
      const rest = raw.slice(i);
      if (/^undefined\b/.test(rest)) {
        result += "null";
        i += "undefined".length - 1;
        continue;
      }
      if (/^NaN\b/.test(rest)) {
        result += "null";
        i += "NaN".length - 1;
        continue;
      }
      if (/^Infinity\b/.test(rest)) {
        result += "null";
        i += "Infinity".length - 1;
        continue;
      }
      if (/^-Infinity\b/.test(rest)) {
        result += "null";
        i += "-Infinity".length - 1;
        continue;
      }

      result += ch;
    }

    return result;
  },
};

/**
 * Add missing closing brackets/braces.
 */
const addMissingBrackets: JsonRecoveryFixer = {
  name: "add_missing_brackets",
  description: "Insert missing closing brackets/braces at correct positions",
  apply(raw: string): string {
    let s = raw.trim();
    // Strip trailing junk after the last JSON-structural closing character
    const lastClose = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
    if (lastClose >= 0 && lastClose < s.length - 1) {
      s = s.slice(0, lastClose + 1);
    }

    // Walk the string and repair the bracket sequence. When we encounter
    // a closing bracket/brace that doesn't match what's expected (e.g. `}`
    // when `]` is expected because an array is still open), we insert the
    // expected closer before the mismatched one. At the end we append any
    // remaining open closers.
    const stack: string[] = [];
    let inString = false;
    let escape = false;
    const result: string[] = [];

    for (const ch of s) {
      if (escape) {
        escape = false;
        result.push(ch);
        continue;
      }
      if (ch === "\\") {
        escape = true;
        result.push(ch);
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        result.push(ch);
        continue;
      }
      if (inString) {
        result.push(ch);
        continue;
      }

      if (ch === "{" || ch === "[") {
        stack.push(ch === "{" ? "}" : "]");
        result.push(ch);
      } else if (ch === "}" || ch === "]") {
        // Insert any missing closers before this one
        const expected = stack.length > 0 ? stack[stack.length - 1] : undefined;
        while (stack.length > 0 && stack[stack.length - 1] !== ch) {
          const missing = stack.pop()!;
          result.push(missing);
        }
        if (stack.length > 0) stack.pop(); // consume the matched opener
        result.push(ch);
      } else {
        result.push(ch);
      }
    }

    // Append any remaining open closers
    while (stack.length > 0) {
      result.push(stack.pop()!);
    }

    return result.join("");
  },
};

// ---------------------------------------------------------------------------
// Ordered fixer pipeline
// ---------------------------------------------------------------------------

/**
 * Default fixers applied in order. Each fixer transforms the raw string;
 * the pipeline stops as soon as JSON.parse succeeds.
 */
export const DEFAULT_FIXERS: readonly JsonRecoveryFixer[] = [
  stripMarkdownFences,
  stripSurroundingText,
  removeComments,
  replaceSingleQuotes,
  removeTrailingCommas,
  quoteUnquotedKeys,
  replaceJsLiterals,
  addMissingBrackets,
];

// ---------------------------------------------------------------------------
// Recovery: try each fixer, then try combinations
// ---------------------------------------------------------------------------

/**
 * Try a single fixer and parse the result. Returns the parsed value if
 * successful, undefined otherwise.
 */
function tryFixer(
  raw: string,
  fixer: JsonRecoveryFixer,
): { parsed: unknown; fixName: string } | undefined {
  try {
    const fixed = fixer.apply(raw);
    const value = JSON.parse(fixed);
    return { parsed: value, fixName: fixer.name };
  } catch {
    return undefined;
  }
}

/**
 * Apply fixers sequentially, trying to parse after each one.
 * Returns the first successful parse or undefined.
 */
function tryFixersSequentially(
  raw: string,
  fixers: readonly JsonRecoveryFixer[],
): { parsed: unknown; fixNames: string[] } | undefined {
  let current = raw;
  const applied: string[] = [];

  for (const fixer of fixers) {
    const next = fixer.apply(current);
    applied.push(fixer.name);

    try {
      const value = JSON.parse(next);
      return { parsed: value, fixNames: [...applied] };
    } catch {
      current = next;
      continue;
    }
  }

  return undefined;
}

/**
 * Try individual fixers first (one at a time), then fall back to the
 * sequential pipeline. Returns a tagged result.
 */
export function tryFixJson(raw: string): JsonRecoveryResult {
  // Quick check: is it already valid JSON?
  try {
    return { _tag: "recovered", value: JSON.parse(raw), fixes: [] };
  } catch {
    // continue with recovery
  }

  // Phase 1: try each fixer individually
  for (const fixer of DEFAULT_FIXERS) {
    const result = tryFixer(raw, fixer);
    if (result) {
      return {
        _tag: "recovered",
        value: result.parsed,
        fixes: [result.fixName],
      };
    }
  }

  // Phase 2: sequential pipeline (all fixers in order)
  const sequential = tryFixersSequentially(raw, DEFAULT_FIXERS);
  if (sequential) {
    return {
      _tag: "recovered",
      value: sequential.parsed,
      fixes: sequential.fixNames,
    }
  }

  // Phase 3: pairwise combinations of fixers (for compound errors)
  for (let i = 0; i < DEFAULT_FIXERS.length; i++) {
    for (let j = 0; j < DEFAULT_FIXERS.length; j++) {
      if (i === j) continue;
      try {
        const step1 = DEFAULT_FIXERS[i]!.apply(raw);
        const step2 = DEFAULT_FIXERS[j]!.apply(step1);
        const value = JSON.parse(step2);
        return {
          _tag: "recovered",
          value,
          fixes: [DEFAULT_FIXERS[i]!.name, DEFAULT_FIXERS[j]!.name],
        };
      } catch {
        continue;
      }
    }
  }

  // Phase 4: sequential pipeline + individual fixer on top (for triple errors)
  for (const fixer of DEFAULT_FIXERS) {
    try {
      const step1 = fixer.apply(raw);
      const sequential = tryFixersSequentially(step1, DEFAULT_FIXERS);
      if (sequential) {
        return {
          _tag: "recovered",
          value: sequential.parsed,
          fixes: [fixer.name, ...sequential.fixNames],
        };
      }
    } catch {
      continue;
    }
  }

  // Give up
  const detection = detectJsonErrors(raw);
  return {
    _tag: "unrecoverable",
    original:
      detection._tag === "json_error"
        ? detection
        : { _tag: "json_error", kind: "unknown", message: "parse failed" },
    attemptedFixes: DEFAULT_FIXERS.map((f) => f.name),
  };
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

/**
 * Attempt to parse raw text as JSON. If parsing fails, try to recover
 * by applying fixers. Returns a tagged result indicating success or failure
 * with diagnostic information.
 */
export function recoverToolInput(raw: string): JsonRecoveryResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return {
      _tag: "recovered",
      value: {},
      fixes: ["empty_input_default"],
    };
  }

  return tryFixJson(trimmed);
}

/**
 * Convenience function: attempt recovery and return the parsed value,
 * or throw on failure. Useful when callers want to fall back to
 * error handling on failure.
 */
export function recoverJsonOrThrow(raw: string): unknown {
  const result = recoverToolInput(raw);
  if (result._tag === "recovered") {
    return result.value;
  }
  throw new Error(
    `JSON recovery failed: ${result.original.message}` +
      (result.attemptedFixes.length > 0
        ? ` (attempted: ${result.attemptedFixes.join(", ")})`
        : ""),
  );
}

/**
 * Build a human-readable summary of recovery attempts.
 */
export function formatRecoverySummary(result: JsonRecoveryResult): string {
  if (result._tag === "recovered") {
    if (result.fixes.length === 0) {
      return "JSON was already valid.";
    }
    return `Recovered using: ${result.fixes.join(" → ")}`;
  }
  return (
    `Unrecoverable JSON error: ${result.original.message} (kind: ${result.original.kind})` +
    `\nAttempted fixes: ${result.attemptedFixes.join(", ")}`
  );
}
