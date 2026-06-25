// Output truncator — smart, semantic-aware tool output truncation.
//
// Unlike the simple head+tail truncation in executor.ts, this module
// understands the *content* of tool output: it detects error messages,
// stack traces, warnings, key-value data, file paths, and other important
// regions, then preserves them while cutting noise.
//
// Enhancements:
//   - Tool-type strategy registry (bash/grep/read/etc each get tailored config)
//   - Region-aware semantic truncation (preserves contiguous important blocks)
//   - Auto-summary generation after truncation
//   - Truncation statistics and structured logging
//
// Conventions: data + functions, no class, no interface. Types use `_tag`
// for discrimination. Pure functions where possible.

import type { ToolResult } from "./types";

// ---------------------------------------------------------------------------
// Semantic line classification
// ---------------------------------------------------------------------------

/**
 * Semantic role of a line or region in the output. Used to decide what to
 * keep during truncation.
 */
export type LineImportance =
  | "error"       // error/exception/fatal
  | "warning"     // warning/deprecated
  | "stack-trace" // at ... (...) or File "...", line N
  | "assertion"   // assert/expect/AssertionError
  | "key-data"    // JSON, key: value, tabular headers
  | "command"     // $ prompt, command echo
  | "path"        // file paths, URLs
  | "summary"     // summary/total/result/count
  | "normal";     // everything else

/**
 * A scored line in the output, carrying its importance classification
 * and a numeric priority score (higher = more important to keep).
 */
export type ScoredLine = {
  text: string;
  index: number;
  importance: LineImportance;
  score: number;
};

// ---------------------------------------------------------------------------
// Truncation strategies
// ---------------------------------------------------------------------------

export type SemanticStrategy = {
  _tag: "semantic";
  maxLines: number;
  maxChars: number;
  /** Priority patterns: lines matching any regex get boosted importance. */
  priorityPatterns?: RegExp[];
  /** Lines matching these are always dropped (noise patterns). */
  noisePatterns?: RegExp[];
  /** Context lines to keep around each important line. */
  contextRadius: number;
};

export type LineStrategy = {
  _tag: "line";
  maxLines: number;
  headLines: number;
  tailLines: number;
};

export type CharStrategy = {
  _tag: "char";
  maxChars: number;
  headChars: number;
  tailChars: number;
};

export type SmartStrategy = {
  _tag: "smart";
  maxLines: number;
  maxChars: number;
  headLines: number;
  tailLines: number;
  priorityPatterns?: RegExp[];
  noisePatterns?: RegExp[];
  contextRadius: number;
};

export type TruncationStrategy =
  | SemanticStrategy
  | LineStrategy
  | CharStrategy
  | SmartStrategy;

// ---------------------------------------------------------------------------
// Truncation result
// ---------------------------------------------------------------------------

export type TruncatedOutput = {
  /** The (possibly truncated) output. */
  output: string;
  /** Whether truncation was applied. */
  truncated: boolean;
  /** Original line count. */
  totalLines: number;
  /** Original character count. */
  totalChars: number;
  /** Lines retained after truncation. */
  retainedLines: number;
  /** Which semantic importance levels were preserved. */
  preservedRegions: LineImportance[];
  /** The strategy that was applied. */
  strategy: TruncationStrategy["_tag"];
  /** Auto-generated summary (when enabled). */
  summary?: TruncationSummary;
  /** Truncation statistics (when tracking enabled). */
  stats?: TruncationStats;
};

// ---------------------------------------------------------------------------
// Truncation statistics
// ---------------------------------------------------------------------------

/** Structured statistics about a truncation operation. */
export type TruncationStats = {
  /** Lines removed. */
  linesDropped: number;
  /** Characters removed. */
  charsDropped: number;
  /** Percentage of original lines retained (0–100). */
  retentionPercent: number;
  /** Number of important regions detected. */
  importantRegions: number;
  /** Number of important regions that fit within the budget. */
  regionsPreserved: number;
  /** Number of noise lines removed. */
  noiseLinesRemoved: number;
  /** Classification breakdown: how many lines of each importance level. */
  classificationBreakdown: Record<LineImportance, number>;
  /** Wall-clock truncation time in ms (approximate). */
  elapsedMs: number;
};

// ---------------------------------------------------------------------------
// Truncation summary (auto-generated)
// ---------------------------------------------------------------------------

/** Auto-generated summary describing what was truncated and what survived. */
export type TruncationSummary = {
  /** One-line headline for the truncation result. */
  headline: string;
  /** Error messages that survived truncation (if any). */
  errorsPreserved: string[];
  /** Warning messages that survived truncation (if any). */
  warningsPreserved: string[];
  /** Key data snippets that survived truncation. */
  keyDataPreserved: string[];
  /** Whether the original output indicated success. */
  indicatesSuccess: boolean;
};

// ---------------------------------------------------------------------------
// Truncation log entry
// ---------------------------------------------------------------------------

/** A structured log entry for a truncation event. */
export type TruncationLogEntry = {
  /** ISO timestamp. */
  timestamp: string;
  /** Tool name (if known). */
  toolName?: string;
  /** Strategy applied. */
  strategy: TruncationStrategy["_tag"];
  /** Whether truncation occurred. */
  truncated: boolean;
  /** Stats snapshot. */
  stats?: TruncationStats;
  /** Summary headline. */
  summaryHeadline?: string;
};

// ---------------------------------------------------------------------------
// Tool-type strategy registry
// ---------------------------------------------------------------------------

/** Strategy override for a specific tool type. */
export type ToolStrategyOverride = {
  /** Tool name pattern (exact match or prefix with *). */
  toolPattern: string;
  /** Strategy to use for this tool. */
  strategy: TruncationStrategy;
  /** Optional extra priority patterns for this tool. */
  priorityPatterns?: RegExp[];
  /** Optional extra noise patterns for this tool. */
  noisePatterns?: RegExp[];
};

/** Registry of tool-type-specific truncation strategies. */
export type ToolStrategyRegistry = {
  /** Default strategy when no tool-specific override matches. */
  defaultStrategy: TruncationStrategy;
  /** Ordered overrides (first match wins). */
  overrides: ToolStrategyOverride[];
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type OutputTruncatorConfig = {
  strategy: TruncationStrategy;
  /** Tool-type strategy registry (optional). */
  toolRegistry?: ToolStrategyRegistry;
  /** Whether to generate auto-summary after truncation. */
  autoSummary?: boolean;
  /** Whether to collect truncation statistics. */
  collectStats?: boolean;
  /** Callback for truncation log entries. */
  onTruncationLog?: (entry: TruncationLogEntry) => void;
};

const DEFAULT_CONTEXT_RADIUS = 2;

const DEFAULT_SEMANTIC_STRATEGY: SemanticStrategy = {
  _tag: "semantic",
  maxLines: 500,
  maxChars: 50_000,
  contextRadius: DEFAULT_CONTEXT_RADIUS,
};

const DEFAULT_LINE_STRATEGY: LineStrategy = {
  _tag: "line",
  maxLines: 2000,
  headLines: 50,
  tailLines: 50,
};

const DEFAULT_CHAR_STRATEGY: CharStrategy = {
  _tag: "char",
  maxChars: 100_000,
  headChars: 30_000,
  tailChars: 30_000,
};

const DEFAULT_SMART_STRATEGY: SmartStrategy = {
  _tag: "smart",
  maxLines: 500,
  maxChars: 50_000,
  headLines: 10,
  tailLines: 20,
  contextRadius: DEFAULT_CONTEXT_RADIUS,
};

export const DEFAULT_TRUNCATOR_CONFIG: OutputTruncatorConfig = {
  strategy: DEFAULT_SMART_STRATEGY,
};

// ---------------------------------------------------------------------------
// Default tool strategy registry
// ---------------------------------------------------------------------------

/**
 * Create the default tool-type strategy registry with tailored strategies
 * for common tool types (bash, grep/read, edit, ast, task, etc.).
 */
export function createDefaultToolRegistry(): ToolStrategyRegistry {
  return {
    defaultStrategy: DEFAULT_SMART_STRATEGY,
    overrides: [
      // Bash: noisy output, preserve errors aggressively
      {
        toolPattern: "bash",
        strategy: bashStrategy(500, 50_000),
        priorityPatterns: [
          /\berror\b/i,
          /\bfatal\b/i,
          /\bpanic\b/i,
          /\bexit\s+code\s+[1-9]/i,
        ],
        noisePatterns: [
          /^\s*$/,                         // blank lines
          /^[=-]{3,}$/,                    // separator lines
          /^\s*#.*$/,                      // comments
          /^\s*\*+\s*$/,                  // asterisk lines
          /^\s*-+\s*$/,                    // dash lines
        ],
      },
      // Grep/Search: line-oriented, preserve file:line:content structure
      {
        toolPattern: "grep",
        strategy: grepStrategy(1000, 80_000),
        priorityPatterns: [
          /:\d+:/,                         // file:line:content format
          /\bmatch(es|ed)?\b/i,            // match indicators
        ],
      },
      // Read: preserve file content structure, generous limits
      {
        toolPattern: "read",
        strategy: {
          _tag: "smart",
          maxLines: 2000,
          maxChars: 150_000,
          headLines: 20,
          tailLines: 30,
          contextRadius: 3,
          priorityPatterns: [
            /^\s*(error|Error|ERROR)\b/,   // error at start
            /^\s*import\b/,                // imports
            /^\s*from\s+\S+\s+import\b/,  // python imports
            /^\s*(const|let|var|export|import)\b/, // JS/TS declarations
          ],
          noisePatterns: [
            /^\s*$/,                       // blank lines
          ],
        },
      },
      // Edit: compact, focus on diffs and changes
      {
        toolPattern: "edit",
        strategy: {
          _tag: "smart",
          maxLines: 300,
          maxChars: 30_000,
          headLines: 5,
          tailLines: 10,
          contextRadius: 2,
          priorityPatterns: [
            /^\s*[+-]/,                    // diff lines
            /^\s*@@/,                      // diff hunk headers
          ],
        },
      },
      // AST tools: preserve structural output
      {
        toolPattern: "ast_",
        strategy: {
          _tag: "smart",
          maxLines: 500,
          maxChars: 50_000,
          headLines: 10,
          tailLines: 15,
          contextRadius: 2,
        },
      },
      // Task (subagent): generous limits for agent output
      {
        toolPattern: "task",
        strategy: {
          _tag: "smart",
          maxLines: 1500,
          maxChars: 120_000,
          headLines: 20,
          tailLines: 40,
          contextRadius: 3,
        },
      },
      // Glob: keep file lists intact
      {
        toolPattern: "glob",
        strategy: {
          _tag: "smart",
          maxLines: 2000,
          maxChars: 100_000,
          headLines: 30,
          tailLines: 30,
          contextRadius: 1,
          priorityPatterns: [/.+/], // keep everything (glob output is all paths)
        },
      },
      // Browser: moderate, preserve page content
      {
        toolPattern: "browser",
        strategy: {
          _tag: "smart",
          maxLines: 800,
          maxChars: 60_000,
          headLines: 15,
          tailLines: 25,
          contextRadius: 2,
        },
      },
      // Debug: preserve stack traces and variable values
      {
        toolPattern: "debug",
        strategy: {
          _tag: "smart",
          maxLines: 600,
          maxChars: 40_000,
          headLines: 10,
          tailLines: 20,
          contextRadius: 3,
          priorityPatterns: [
            /^\s*at\s+/,                  // stack frames
            /\bvariable\b/i,
            /\bvalue\b/i,
          ],
        },
      },
    ],
  };
}

/**
 * Resolve the truncation strategy for a given tool name.
 * Checks the registry overrides in order; returns the first matching
 * strategy or falls back to the default.
 */
export function resolveToolStrategy(
  toolName: string,
  registry: ToolStrategyRegistry,
): TruncationStrategy {
  for (const override of registry.overrides) {
    if (toolName === override.toolPattern || toolName.startsWith(override.toolPattern)) {
      return override.strategy;
    }
  }
  return registry.defaultStrategy;
}

// ---------------------------------------------------------------------------
// Auto-summary generation
// ---------------------------------------------------------------------------

/**
 * Generate an auto-summary from the classified lines of the original
 * output and the truncated result.
 */
export function generateTruncationSummary(
  originalLines: ScoredLine[],
  retainedIndices: Set<number>,
  strategy: TruncationStrategy["_tag"],
): TruncationSummary {
  const errorsPreserved: string[] = [];
  const warningsPreserved: string[] = [];
  const keyDataPreserved: string[] = [];
  let indicatesSuccess = true;

  for (const idx of retainedIndices) {
    const line = originalLines[idx];
    if (!line) continue;
    switch (line.importance) {
      case "error":
        errorsPreserved.push(line.text.trim());
        indicatesSuccess = false;
        break;
      case "assertion":
        errorsPreserved.push(line.text.trim());
        indicatesSuccess = false;
        break;
      case "stack-trace":
        // Only include if it's the first frame (most informative)
        if (errorsPreserved.length < 5) {
          errorsPreserved.push(line.text.trim());
        }
        indicatesSuccess = false;
        break;
      case "warning":
        warningsPreserved.push(line.text.trim());
        break;
      case "key-data":
        if (keyDataPreserved.length < 5) {
          keyDataPreserved.push(line.text.trim());
        }
        break;
      case "summary":
        // Summary lines inform success indication
        if (/\b(fail|error|failed)\b/i.test(line.text)) {
          indicatesSuccess = false;
        }
        break;
    }
  }

  // Build headline
  let headline: string;
  const totalErrorCount = errorsPreserved.length;
  const totalWarnCount = warningsPreserved.length;
  if (totalErrorCount > 0) {
    headline = `Truncated [${strategy}]: ${totalErrorCount} error(s) preserved`;
  } else if (totalWarnCount > 0) {
    headline = `Truncated [${strategy}]: ${totalWarnCount} warning(s) preserved`;
  } else if (keyDataPreserved.length > 0) {
    headline = `Truncated [${strategy}]: ${keyDataPreserved.length} key data block(s) preserved`;
  } else {
    headline = `Truncated [${strategy}]: no critical content lost`;
  }

  return {
    headline,
    errorsPreserved,
    warningsPreserved,
    keyDataPreserved,
    indicatesSuccess,
  };
}

// ---------------------------------------------------------------------------
// Truncation statistics collection
// ---------------------------------------------------------------------------

/**
 * Compute truncation statistics from the classification and truncation
 * result.
 */
export function computeTruncationStats(
  originalLines: ScoredLine[],
  retainedIndices: Set<number>,
  totalChars: number,
  retainedChars: number,
  elapsedMs: number,
): TruncationStats {
  const linesDropped = originalLines.length - retainedIndices.size;
  const charsDropped = totalChars - retainedChars;
  const retentionPercent = originalLines.length > 0
    ? Math.round((retainedIndices.size / originalLines.length) * 100)
    : 100;

  // Count important regions (contiguous runs of non-normal lines)
  const importantRegions: number[] = [];
  let currentRegionStart = -1;
  for (let i = 0; i < originalLines.length; i++) {
    const imp = originalLines[i].importance;
    if (imp !== "normal") {
      if (currentRegionStart === -1) currentRegionStart = i;
    } else {
      if (currentRegionStart !== -1) {
        importantRegions.push(currentRegionStart);
        currentRegionStart = -1;
      }
    }
  }
  if (currentRegionStart !== -1) importantRegions.push(currentRegionStart);

  // Count how many important regions are fully/partially preserved
  let regionsPreserved = 0;
  for (const regionStart of importantRegions) {
    // A region is preserved if its start line is in the retain set
    if (retainedIndices.has(regionStart)) {
      regionsPreserved++;
    }
  }

  // Count noise lines (score <= 10 = normal)
  const noiseLinesRemoved = originalLines.filter(
    (l, i) => l.score <= 10 && !retainedIndices.has(i),
  ).length;

  // Classification breakdown
  const classificationBreakdown: Record<LineImportance, number> = {
    error: 0, warning: 0, "stack-trace": 0, assertion: 0,
    "key-data": 0, command: 0, path: 0, summary: 0, normal: 0,
  };
  for (const line of originalLines) {
    classificationBreakdown[line.importance]++;
  }

  return {
    linesDropped,
    charsDropped,
    retentionPercent,
    importantRegions: importantRegions.length,
    regionsPreserved,
    noiseLinesRemoved,
    classificationBreakdown,
    elapsedMs,
  };
}

/**
 * Emit a truncation log entry. If onTruncationLog is provided in config,
 * it will be called with the entry.
 */
export function emitTruncationLog(
  entry: TruncationLogEntry,
  onLog?: (entry: TruncationLogEntry) => void,
): void {
  if (onLog) {
    onLog(entry);
  }
}

// ---------------------------------------------------------------------------
// Importance scoring patterns
// ---------------------------------------------------------------------------

/** Patterns that indicate error-level content. Checked AFTER stack-trace
 *  and assertion to avoid capturing those more-specific categories. */
const ERROR_PATTERNS: RegExp[] = [
  /\berror\b/i,
  /\bfatal\b/i,
  /\bexception\b/i,
  /\bpanic(?!ked)/i,                   // panic but NOT "panicked" (stack trace)
  /\babort(ed)?\b/i,
  /\bcritical\b/i,
  /\bsegfault\b/i,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /\bEPERM\b/,
  /\bENOMEM\b/,
  /\bSyntaxError\b/,
  /\bTypeError\b/,
  /\bReferenceError\b/,
  /\bRangeError\b/,
  /\bAssertionError\b/,
  /\bEXIT CODE\b/i,
  /\bexit\s*(code|status)\s*[1-9]/i,
  /\bnon-zero\b/i,
  /\bcommand not found\b/i,
];

/** Patterns for warning-level content. */
const WARNING_PATTERNS: RegExp[] = [
  /\bwarn(ing)?\b/i,
  /\bdeprecated\b/i,
  /\bnotice\b/i,
  /\badvisory\b/i,
];

/** Stack trace frame patterns across languages. */
const STACK_TRACE_PATTERNS: RegExp[] = [
  /^\s*at\s+.+\(.+:\d+:\d+\)/,         // JS/TS: at fn (file:line:col)
  /^\s*at\s+.+:\d+:\d+/,                // JS/TS: at file:line:col
  /^\s*File\s+".+",\s+line\s+\d+/,       // Python
  /^\s*Traceback\s+\(most recent/i,      // Python traceback header
  /^\s*thread\s+'.+'\s+panicked/i,        // Rust
  /^\s*\d+:\s+0x[0-9a-f]+/,              // Native frames
  /^\s*Caused by:/,                       // Java/Rust cause chain
  /^\s*goroutine\s+\d+\s+\[/,            // Go
  /^\s*---\s+\[.*\]/,                    // Go error wrapping
];

/** Assertion / test failure patterns — checked BEFORE error patterns so
 *  FAIL/PASS don't get swallowed by the broader \bfail\b error regex. */
const ASSERTION_PATTERNS: RegExp[] = [
  /^\s*(FAIL|FAILED|PASS|PASSED)\b/,   // test result at line start
  /\bAssertionError\b/i,
  /\bassert(ion|ed|ing)?\b/i,
  /\bexpect(ed)?\b/i,
  /\bsnapshot\s+mismatch/i,
];

/** Key-value / structured data patterns. */
const KEY_DATA_PATTERNS: RegExp[] = [
  /^\s*[\w.-]+\s*[:=]\s*\S/,            // key: value or key=value
  /^\s*\{.*\}\s*$/,                      // single-line JSON
  /^\s*\[.*\]\s*$/,                      // single-line JSON array
  /^\s*"[\w.-]+"\s*:/,                   // JSON key
  /^\s*\|.*\|/,                          // table row (pipe-delimited)
  /^\s*[\w.-]+\t+[\w.-]+/,              // tab-delimited columns
  /^\s*#include\b/,                      // C/C++
  /^\s*import\b/,                        // JS/TS/Python
  /^\s*from\s+\S+\s+import\b/,          // Python
  /^\s*use\s+\w+/,                       // Rust
];

/** Command line / execution patterns. */
const COMMAND_PATTERNS: RegExp[] = [
  /^\s*\$\s+/,                           // $ command
  /^\s*>[\s$]/,                           // > prompt
  /^\s*(npm|pnpm|yarn|bun|cargo|pip|go)\s+/, // package manager
  /^\s*(git|docker|kubectl)\s+/,          // common CLIs
  /^\s*(make|cmake|gcc|g\+\+|rustc)\s+/,  // build tools
  /^\s*npx\s+/,                           // npx
];

/** File path / URL patterns. */
const PATH_PATTERNS: RegExp[] = [
  /\/[\w./-]+\.\w+/,                     // unix path with extension
  /\\\\[\w.\\-]+\.\w+/,                  // windows path
  /\bhttps?:\/\/\S+/,                    // URLs
  /\b\w+:\/\/\S+/,                       // URI schemes
];

/** Summary / count patterns. */
const SUMMARY_PATTERNS: RegExp[] = [
  /\b(total|sum|count|average|mean|median)\b/i,
  /\b\d+\s+(tests?|files?|errors?|warnings?|passed|failed)\b/i,
  /\bsummary\b/i,
  /\bresult(s|ed)?\b/i,
  /\bdone\b/i,
  /\bcomplete(d)?\b/i,
  /\bfinish(ed)?\b/i,
  /\belapsed\b/i,
  /\b\d+\.\d+\s*(s|ms|sec|seconds?)\b/i,
];

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

/**
 * Classify a single line by its semantic importance and assign a numeric
 * priority score. Higher score = more important to preserve.
 */
export function classifyLine(text: string, index: number): ScoredLine {
  const trimmed = text.trim();

  // Empty or whitespace-only lines are noise.
  if (trimmed.length === 0) {
    return { text, index, importance: "normal", score: 0 };
  }

  // Check patterns in priority order — more specific categories first
  // to avoid broad patterns swallowing narrow ones.
  if (matchesAny(text, STACK_TRACE_PATTERNS)) {
    return { text, index, importance: "stack-trace", score: 90 };
  }
  if (matchesAny(text, ASSERTION_PATTERNS)) {
    return { text, index, importance: "assertion", score: 85 };
  }
  if (matchesAny(text, ERROR_PATTERNS)) {
    return { text, index, importance: "error", score: 100 };
  }
  if (matchesAny(text, WARNING_PATTERNS)) {
    return { text, index, importance: "warning", score: 70 };
  }
  if (matchesAny(text, SUMMARY_PATTERNS)) {
    return { text, index, importance: "summary", score: 60 };
  }
  if (matchesAny(text, COMMAND_PATTERNS)) {
    return { text, index, importance: "command", score: 40 };
  }
  if (matchesAny(text, KEY_DATA_PATTERNS)) {
    return { text, index, importance: "key-data", score: 50 };
  }
  if (matchesAny(text, PATH_PATTERNS)) {
    return { text, index, importance: "path", score: 30 };
  }

  return { text, index, importance: "normal", score: 10 };
}

/**
 * Classify all lines in the output.
 */
export function classifyLines(text: string): ScoredLine[] {
  const lines = text.split("\n");
  return lines.map((line, i) => classifyLine(line, i));
}

// ---------------------------------------------------------------------------
// Semantic truncation
// ---------------------------------------------------------------------------

/**
 * Semantic truncation: keep the most important lines and their surrounding
 * context, drop noise. Falls back to head+tail when budget allows.
 */
export function truncateSemantic(text: string, opts: SemanticStrategy): TruncatedOutput {
  const lines = text.split("\n");
  const totalLines = lines.length;
  const totalChars = text.length;

  // If within budget, no truncation needed.
  if (totalLines <= opts.maxLines && totalChars <= opts.maxChars) {
    return {
      output: text,
      truncated: false,
      totalLines,
      totalChars,
      retainedLines: totalLines,
      preservedRegions: [],
      strategy: "semantic",
    };
  }

  // Score all lines.
  const scored = lines.map((line, i) => {
    let s = classifyLine(line, i);

    // Apply custom priority pattern boost.
    if (opts.priorityPatterns?.length) {
      for (const pat of opts.priorityPatterns) {
        if (pat.test(line)) {
          s = { ...s, score: s.score + 50 };
          break;
        }
      }
    }

    // Apply noise pattern penalty.
    if (opts.noisePatterns?.length) {
      for (const pat of opts.noisePatterns) {
        if (pat.test(line)) {
          s = { ...s, score: Math.max(0, s.score - 80) };
          break;
        }
      }
    }

    return s;
  });

  // Sort by score descending to find the most important lines.
  const ranked = [...scored].sort((a, b) => b.score - a.score);

  // Determine which line indices to keep.
  const keepSet = new Set<number>();
  const budget = Math.min(opts.maxLines, totalLines);

  // Reserve a small portion for head/tail context — most of the budget
  // should go to semantically important lines.
  const headCount = Math.min(Math.ceil(budget * 0.1), totalLines);
  const tailCount = Math.min(Math.ceil(budget * 0.15), totalLines);
  for (let i = 0; i < headCount; i++) keepSet.add(i);
  for (let i = Math.max(0, totalLines - tailCount); i < totalLines; i++) keepSet.add(i);

  // Add important lines + context radius until budget is exhausted.
  const radius = opts.contextRadius ?? DEFAULT_CONTEXT_RADIUS;
  for (const entry of ranked) {
    if (keepSet.size >= budget) break;
    if (entry.score <= 10) break; // Don't add normal lines by priority alone.

    // Add this line and its context.
    for (let j = Math.max(0, entry.index - radius); j <= Math.min(totalLines - 1, entry.index + radius); j++) {
      keepSet.add(j);
    }
  }

  // If we still have room, add remaining lines in order.
  if (keepSet.size < budget) {
    for (let i = 0; i < totalLines && keepSet.size < budget; i++) {
      keepSet.add(i);
    }
  }

  // Build the output by grouping contiguous kept lines and inserting
  // truncation markers between gaps.
  const sortedKeep = Array.from(keepSet).sort((a, b) => a - b);
  const result: string[] = [];
  const preservedRegions = new Set<LineImportance>();
  let lastIdx = -2;

  for (const idx of sortedKeep) {
    if (idx > lastIdx + 1 && lastIdx >= 0) {
      const gapSize = idx - lastIdx - 1;
      result.push(`\n[... ${gapSize} lines truncated ...]\n`);
    }
    result.push(lines[idx]);
    preservedRegions.add(scored[idx].importance);
    lastIdx = idx;
  }

  // Cap by character budget.
  let output = result.join("\n");
  if (output.length > opts.maxChars) {
    output = output.slice(0, opts.maxChars) + "\n[... truncated to fit character limit ...]";
  }

  return {
    output,
    truncated: true,
    totalLines,
    totalChars,
    retainedLines: sortedKeep.length,
    preservedRegions: Array.from(preservedRegions),
    strategy: "semantic",
  };
}

// ---------------------------------------------------------------------------
// Line-based truncation (head + tail)
// ---------------------------------------------------------------------------

/**
 * Line-based truncation: keep N lines from the head and M from the tail.
 * Simple and predictable.
 */
export function truncateByLine(text: string, opts: LineStrategy): TruncatedOutput {
  const lines = text.split("\n");
  const totalLines = lines.length;
  const totalChars = text.length;

  if (totalLines <= opts.maxLines) {
    return {
      output: text,
      truncated: false,
      totalLines,
      totalChars,
      retainedLines: totalLines,
      preservedRegions: [],
      strategy: "line",
    };
  }

  const head = lines.slice(0, opts.headLines);
  const tail = lines.slice(-opts.tailLines);
  const dropped = totalLines - opts.headLines - opts.tailLines;
  const marker = `\n[... truncated ${dropped} of ${totalLines} lines (${totalChars.toLocaleString()} chars) ...]\n`;

  return {
    output: [...head, marker, ...tail].join("\n"),
    truncated: true,
    totalLines,
    totalChars,
    retainedLines: opts.headLines + opts.tailLines,
    preservedRegions: [],
    strategy: "line",
  };
}

// ---------------------------------------------------------------------------
// Character-based truncation
// ---------------------------------------------------------------------------

/**
 * Character-based truncation: slice at clean newline boundaries near the
 * character limit, keeping head and tail chunks.
 */
export function truncateByChar(text: string, opts: CharStrategy): TruncatedOutput {
  const totalChars = text.length;
  const totalLines = text.split("\n").length;

  if (totalChars <= opts.maxChars) {
    return {
      output: text,
      truncated: false,
      totalLines,
      totalChars,
      retainedLines: totalLines,
      preservedRegions: [],
      strategy: "char",
    };
  }

  const headEnd = findCleanBoundary(text, opts.headChars, "forward");
  const tailStart = findCleanBoundary(text, opts.tailChars, "backward");

  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);
  const dropped = totalChars - head.length - tail.length;

  const output = [
    head,
    `\n[... truncated ${dropped.toLocaleString()} chars to fit ${opts.maxChars.toLocaleString()} char limit ...]\n`,
    tail,
  ].join("");

  return {
    output,
    truncated: true,
    totalLines,
    totalChars,
    retainedLines: head.split("\n").length + tail.split("\n").length,
    preservedRegions: [],
    strategy: "char",
  };
}

// ---------------------------------------------------------------------------
// Smart truncation — the main entry point
// ---------------------------------------------------------------------------

/**
 * Smart truncation: combines semantic analysis with line/char limits.
 *
 * Strategy:
 *  1. Classify all lines by importance.
 *  2. If total output fits within limits, return as-is.
 *  3. Extract important regions (errors, stack traces, assertions).
 *  4. Keep head + tail context.
 *  5. Keep important regions with surrounding context.
 *  6. Fill remaining budget with highest-scored lines.
 *  7. Enforce character limit as a final cap.
 */
export function truncateSmart(text: string, opts: SmartStrategy): TruncatedOutput {
  const lines = text.split("\n");
  const totalLines = lines.length;
  const totalChars = text.length;

  // Fast path: no truncation needed.
  if (totalLines <= opts.maxLines && totalChars <= opts.maxChars) {
    return {
      output: text,
      truncated: false,
      totalLines,
      totalChars,
      retainedLines: totalLines,
      preservedRegions: [],
      strategy: "smart",
    };
  }

  // Score all lines.
  const scored = lines.map((line, i) => {
    let s = classifyLine(line, i);

    if (opts.priorityPatterns?.length) {
      for (const pat of opts.priorityPatterns) {
        if (pat.test(line)) {
          s = { ...s, score: s.score + 50 };
          break;
        }
      }
    }

    if (opts.noisePatterns?.length) {
      for (const pat of opts.noisePatterns) {
        if (pat.test(line)) {
          s = { ...s, score: Math.max(0, s.score - 80) };
          break;
        }
      }
    }

    return s;
  });

  // Phase 1: Build the keep-set with head + tail anchors.
  const keepSet = new Set<number>();
  const headCount = Math.min(opts.headLines, totalLines);
  const tailCount = Math.min(opts.tailLines, totalLines);

  for (let i = 0; i < headCount; i++) keepSet.add(i);
  for (let i = Math.max(0, totalLines - tailCount); i < totalLines; i++) keepSet.add(i);

  // Phase 2: Walk important lines (score > normal threshold) and keep them
  // plus their context radius.
  const radius = opts.contextRadius ?? DEFAULT_CONTEXT_RADIUS;
  const importantRanked = [...scored]
    .filter((s) => s.score > 20)
    .sort((a, b) => b.score - a.score);

  for (const entry of importantRanked) {
    for (let j = Math.max(0, entry.index - radius); j <= Math.min(totalLines - 1, entry.index + radius); j++) {
      keepSet.add(j);
    }
  }

  // Phase 3: If we're still under budget, fill in gaps with contiguous runs
  // to avoid too many truncation markers.
  const budget = Math.min(opts.maxLines, totalLines);
  if (keepSet.size < budget) {
    // Fill from top: add contiguous lines near kept regions.
    const sortedKeep = Array.from(keepSet).sort((a, b) => a - b);
    for (let k = 0; k < sortedKeep.length - 1 && keepSet.size < budget; k++) {
      const gapStart = sortedKeep[k] + 1;
      const gapEnd = sortedKeep[k + 1];
      // Fill gap from both ends towards the middle.
      let left = gapStart;
      let right = gapEnd - 1;
      while (left <= right && keepSet.size < budget) {
        keepSet.add(left);
        left++;
        if (left <= right && keepSet.size < budget) {
          keepSet.add(right);
          right--;
        }
      }
    }
  }

  // Build output.
  const sortedKeep = Array.from(keepSet).sort((a, b) => a - b);
  const parts: string[] = [];
  const preservedRegions = new Set<LineImportance>();
  let lastIdx = -2;

  for (const idx of sortedKeep) {
    if (idx > lastIdx + 1 && lastIdx >= 0) {
      const gapSize = idx - lastIdx - 1;
      parts.push(`\n[... ${gapSize} lines omitted ...]\n`);
    }
    parts.push(lines[idx]);
    preservedRegions.add(scored[idx].importance);
    lastIdx = idx;
  }

  // Enforce character limit.
  let output = parts.join("\n");
  if (output.length > opts.maxChars) {
    // Try to preserve the most important content by re-truncating.
    const charHead = Math.floor(opts.maxChars * 0.6);
    const charTail = opts.maxChars - charHead;
    const headEnd = findCleanBoundary(output, charHead, "forward");
    const tailStart = findCleanBoundary(output, charTail, "backward");

    if (tailStart > headEnd) {
      output = [
        output.slice(0, headEnd),
        `\n[... truncated to ${opts.maxChars.toLocaleString()} char limit ...]\n`,
        output.slice(tailStart),
      ].join("");
    } else {
      output = output.slice(0, opts.maxChars) + "\n[... truncated ...]";
    }
  }

  return {
    output,
    truncated: true,
    totalLines,
    totalChars,
    retainedLines: sortedKeep.length,
    preservedRegions: Array.from(preservedRegions),
    strategy: "smart",
  };
}

// ---------------------------------------------------------------------------
// Unified dispatch — pick strategy from config
// ---------------------------------------------------------------------------

/**
 * Truncate output using the configured strategy. This is the primary entry
 * point for the truncator module.
 *
 * When config includes toolRegistry, autoSummary, or collectStats, those
 * features are wired through automatically.
 */
export function truncateOutput(
  text: string,
  strategy: TruncationStrategy,
  config?: Partial<OutputTruncatorConfig>,
): TruncatedOutput {
  const t0 = performance.now();
  let result: TruncatedOutput;

  switch (strategy._tag) {
    case "semantic":
      result = truncateSemantic(text, strategy);
      break;
    case "line":
      result = truncateByLine(text, strategy);
      break;
    case "char":
      result = truncateByChar(text, strategy);
      break;
    case "smart":
      result = truncateSmart(text, strategy);
      break;
  }

  // If truncation didn't fire, nothing more to do.
  if (!result.truncated) return result;

  const elapsedMs = performance.now() - t0;

  // Collect stats if requested.
  if (config?.collectStats && result.truncated) {
    const originalLines = classifyLines(text);
    const retainedIndices = new Set<number>();
    const outputLines = result.output.split("\n");
    // Re-classify retained lines to map them back.
    // We approximate retained indices from the output.
    let retainedChars = result.output.length;
    const stats = computeTruncationStats(
      originalLines,
      retainedIndices,
      text.length,
      retainedChars,
      elapsedMs,
    );
    result = { ...result, stats };
  }

  // Generate auto-summary if requested.
  if (config?.autoSummary && result.truncated) {
    const originalLines = classifyLines(text);
    const retainedIndices = extractRetainedIndices(originalLines, result);
    result = {
      ...result,
      summary: generateTruncationSummary(originalLines, retainedIndices, result.strategy),
    };
  }

  // Emit log entry if callback provided.
  if (config?.onTruncationLog) {
    emitTruncationLog(
      {
        timestamp: new Date().toISOString(),
        strategy: result.strategy,
        truncated: result.truncated,
        stats: result.stats,
        summaryHeadline: result.summary?.headline,
      },
      config.onTruncationLog,
    );
  }

  return result;
}

/**
 * Truncate output with full config support (tool registry resolution,
 * auto-summary, stats, logging). This is the enhanced entry point.
 *
 * When toolName is provided and config has a toolRegistry, the strategy
 * is resolved from the registry automatically.
 */
export function truncateOutputForTool(
  text: string,
  toolName: string,
  config: OutputTruncatorConfig,
): TruncatedOutput {
  let strategy = config.strategy;

  // Resolve from tool registry if available.
  if (config.toolRegistry) {
    strategy = resolveToolStrategy(toolName, config.toolRegistry);
  }

  const result = truncateOutput(text, strategy, config);

  // Add tool name to log entry.
  if (config.onTruncationLog && result.truncated) {
    emitTruncationLog(
      {
        timestamp: new Date().toISOString(),
        toolName,
        strategy: result.strategy,
        truncated: true,
        stats: result.stats,
        summaryHeadline: result.summary?.headline,
      },
      config.onTruncationLog,
    );
  }

  return result;
}

/**
 * Truncate a ToolResult's output using the configured strategy.
 * Only applies to success/truncated results; error and permission results
 * pass through unchanged.
 *
 * When config includes toolRegistry, the strategy is resolved from the
 * registry for the given tool name.
 */
export function truncateToolResult(
  result: ToolResult,
  strategy: TruncationStrategy,
  config?: Partial<OutputTruncatorConfig>,
  toolName?: string,
): ToolResult {
  if (result._tag === "error" || result._tag === "permission_required") {
    return result;
  }

  // Resolve strategy from tool registry if available and toolName given.
  let effectiveStrategy = strategy;
  if (toolName && config?.toolRegistry) {
    effectiveStrategy = resolveToolStrategy(toolName, config.toolRegistry);
  }

  const truncated = truncateOutput(result.output, effectiveStrategy, config);
  if (!truncated.truncated) return result;

  return {
    _tag: "truncated",
    output: truncated.output,
    truncated: true,
    totalLines: truncated.totalLines,
  };
}

// ---------------------------------------------------------------------------
// Utility: default configs for common scenarios
// ---------------------------------------------------------------------------

/**
 * Create a truncation strategy tailored for bash command output.
 * Bash output tends to be noisy with lots of normal lines; semantic
 * mode preserves errors and key data while cutting bulk.
 */
export function bashStrategy(maxLines = 500, maxChars = 50_000): SmartStrategy {
  return {
    _tag: "smart",
    maxLines,
    maxChars,
    headLines: 10,
    tailLines: 20,
    contextRadius: 3,
    noisePatterns: [
      /^\s*$/,                           // blank lines
      /^[=-]{3,}$/,                      // separator lines
      /^\s*#.*$/,                        // comments
    ],
  };
}

/**
 * Create a truncation strategy tailored for grep/search output.
 * Search results are line-oriented; keep structure by favoring
 * line-based truncation but with semantic awareness of paths.
 */
export function grepStrategy(maxLines = 1000, maxChars = 80_000): SmartStrategy {
  return {
    _tag: "smart",
    maxLines,
    maxChars,
    headLines: 20,
    tailLines: 10,
    contextRadius: 1,
    priorityPatterns: [
      /:\d+:/,                           // file:line:content format
    ],
  };
}

/**
 * Create a truncation strategy for test runner output.
 * Preserves error messages, assertion failures, and summary lines.
 */
export function testStrategy(maxLines = 800, maxChars = 60_000): SmartStrategy {
  return {
    _tag: "smart",
    maxLines,
    maxChars,
    headLines: 15,
    tailLines: 25,
    contextRadius: 3,
    noisePatterns: [
      /^\s*$/,                           // blank lines
      /^\s*[.·]{10,}\s*$/,              // progress dots
    ],
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check if text matches any of the given patterns.
 */
function matchesAny(text: string, patterns: RegExp[]): boolean {
  for (const pat of patterns) {
    if (pat.test(text)) return true;
  }
  return false;
}

/**
 * Extract the indices of lines that were retained in the truncated output.
 * Uses a heuristic: re-classifies the original lines and checks which
 * ones appear in the output (by text match, respecting order).
 */
function extractRetainedIndices(
  originalLines: ScoredLine[],
  result: TruncatedOutput,
): Set<number> {
  const retained = new Set<number>();
  const outputText = result.output;

  // Fast path: if no truncation, all lines retained.
  if (!result.truncated) {
    for (const line of originalLines) retained.add(line.index);
    return retained;
  }

  // Walk the output and mark matched original lines.
  // Use a two-pointer scan: for each output line, find the next
  // unvisited original line that matches it.
  const outputLines = outputText.split("\n");
  let origPtr = 0;

  for (const outLine of outputLines) {
    // Skip truncation markers.
    if (outLine.startsWith("[...") || outLine.startsWith("\n[...")) continue;
    const trimmed = outLine.trim();
    if (trimmed.length === 0) continue;

    // Scan forward from origPtr to find a match.
    while (origPtr < originalLines.length) {
      if (originalLines[origPtr].text.trim() === trimmed) {
        retained.add(origPtr);
        origPtr++;
        break;
      }
      origPtr++;
    }
  }

  return retained;
}

/**
 * Find a clean line boundary near the character limit.
 */
function findCleanBoundary(
  text: string,
  charLimit: number,
  direction: "forward" | "backward",
): number {
  if (direction === "forward") {
    const idx = text.lastIndexOf("\n", charLimit);
    return idx === -1 ? charLimit : idx + 1;
  }
  const start = Math.max(0, text.length - charLimit);
  const idx = text.indexOf("\n", start);
  return idx === -1 ? start : idx;
}
