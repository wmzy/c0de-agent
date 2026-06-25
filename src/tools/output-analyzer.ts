// Output analyzer — semantic analysis of tool output.
//
// Detects error patterns, extracts key information (error messages, warnings,
// suggestions), and generates output summaries. Supports text, JSON, and log
// output formats.
//
// Conventions: data + functions, no class, no interface. Types use `_tag`
// for discrimination. Pure functions.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Severity of a detected error pattern. */
export type ErrorSeverity = "fatal" | "error" | "warning" | "info";

/** A detected error pattern in the output. */
export type ErrorPattern = {
  /** The regex pattern that matched. */
  pattern: string;
  /** Severity level. */
  severity: ErrorSeverity;
  /** The matched text. */
  match: string;
  /** Line number (1-based) where the match occurred. */
  line: number;
  /** Human-readable description of the error. */
  message: string;
};

/** A suggestion extracted from the output. */
export type Suggestion = {
  /** The suggestion text. */
  text: string;
  /** Line number (1-based). */
  line: number;
};

/** Extracted structured information from the output. */
export type ExtractedInfo = {
  /** Error messages found. */
  errors: string[];
  /** Warning messages found. */
  warnings: string[];
  /** Suggestions / recommendations found. */
  suggestions: Suggestion[];
  /** File paths referenced in the output. */
  paths: string[];
  /** Exit codes detected. */
  exitCodes: number[];
};

/** Detected output format. */
export type OutputFormat =
  | { _tag: "text" }
  | { _tag: "json"; valid: boolean; depth?: number }
  | { _tag: "log"; format: "jsonl" | "ndjson" | "structured" | "plain" }
  | { _tag: "stack-trace" }
  | { _tag: "diff" }
  | { _tag: "table" }
  | { _tag: "unknown" };

/** Summary of the output analysis. */
export type AnalysisSummary = {
  /** Brief one-line summary. */
  headline: string;
  /** Longer description of what the output contains. */
  description: string;
  /** Whether the output indicates success. */
  isSuccess: boolean;
  /** Whether the output contains errors. */
  hasErrors: boolean;
  /** Whether the output contains warnings. */
  hasWarnings: boolean;
  /** Number of lines in the output. */
  lineCount: number;
  /** Number of characters in the output. */
  charCount: number;
};

/** Result of analyzing tool output. */
export type AnalysisResult = {
  /** The detected output format. */
  format: OutputFormat;
  /** Detected error patterns. */
  errors: ErrorPattern[];
  /** Extracted key information. */
  info: ExtractedInfo;
  /** Summary of the analysis. */
  summary: AnalysisSummary;
};

// ---------------------------------------------------------------------------
// Error pattern definitions
// ---------------------------------------------------------------------------

/**
 * Error patterns ordered by severity. Each entry has a regex, severity,
 * and a function to extract a human-readable message from the match.
 */
type ErrorPatternDef = {
  regex: RegExp;
  severity: ErrorSeverity;
  extract: (match: string, line: string) => string;
};

const ERROR_PATTERNS: ErrorPatternDef[] = [
  // Fatal / crash patterns
  {
    regex: /\b(fatal|FATAL)\b/i,
    severity: "fatal",
    extract: (_m, line) => line.trim(),
  },
  {
    regex: /\bsegfault\b/i,
    severity: "fatal",
    extract: (_m, line) => `Segmentation fault: ${line.trim()}`,
  },
  {
    regex: /\bpanic(?!ked)/i,
    severity: "fatal",
    extract: (_m, line) => line.trim(),
  },
  {
    regex: /\babort(ed)?\b/i,
    severity: "fatal",
    extract: (_m, line) => `Aborted: ${line.trim()}`,
  },

  // Exit codes
  {
    regex: /\b(EXIT CODE|exit code|exit status)\s*[:=]?\s*(\d+)/i,
    severity: "error",
    extract: (match) => {
      const m = match.match(/\b(EXIT CODE|exit code|exit status)\s*[:=]?\s*(\d+)/i);
      return m ? `Exit code ${m[2]}` : match;
    },
  },
  {
    regex: /\bcommand not found\b/i,
    severity: "error",
    extract: (_m, line) => `Command not found: ${line.trim()}`,
  },

  // Standard error patterns
  {
    regex: /\b(error|ERROR)\b/i,
    severity: "error",
    extract: (_m, line) => line.trim(),
  },
  {
    regex: /\b(exception|Exception)\b/i,
    severity: "error",
    extract: (_m, line) => line.trim(),
  },

  // JavaScript / TypeScript errors
  {
    regex: /\b(SyntaxError|TypeError|ReferenceError|RangeError|URIError|EvalError)\b/,
    severity: "error",
    extract: (match, line) => `${match}: ${line.trim()}`,
  },
  {
    regex: /\bAssertionError\b/,
    severity: "error",
    extract: (_m, line) => `Assertion failed: ${line.trim()}`,
  },

  // POSIX error codes
  {
    regex: /\b(ENOENT|EACCES|EPERM|ENOMEM|EEXIST|EINVAL|EISDIR|ENOTDIR|EBUSY|EIO|ENOSPC)\b/,
    severity: "error",
    extract: (match, line) => `${match}: ${line.trim()}`,
  },

  // Python errors
  {
    regex: /\b(ModuleNotFoundError|ImportError|FileNotFoundError|PermissionError|IsADirectoryError|NotADirectoryError|ProcessLookupError|TimeoutError|ConnectionError|OSError|ValueError|KeyError|IndexError|AttributeError|NameError|ZeroDivisionError|OverflowError|RecursionError)\b/,
    severity: "error",
    extract: (match, line) => `${match}: ${line.trim()}`,
  },

  // Go errors
  {
    regex: /\b(goroutine\s+\d+\s+\[|panic:|fatal error:)\b/i,
    severity: "error",
    extract: (_m, line) => line.trim(),
  },

  // Rust errors
  {
    regex: /\b(thread\s+'.+'\s+panicked|Caused by:)\b/i,
    severity: "error",
    extract: (_m, line) => line.trim(),
  },

  // Compilation / build errors
  {
    regex: /\b(compilation error|build failed|build error|compile error|syntax error|parse error)\b/i,
    severity: "error",
    extract: (_m, line) => line.trim(),
  },

  // Network errors
  {
    regex: /\b(connection refused|connection timed out|connection reset|ECONNREFUSED|ETIMEDOUT|ECONNRESET)\b/i,
    severity: "error",
    extract: (_m, line) => line.trim(),
  },

  // HTTP errors
  {
    regex: /\b(HTTP\s*)?(\d{3})\s+(error|failed|not found|forbidden|unauthorized|internal server error|bad gateway|service unavailable)/i,
    severity: "error",
    extract: (match) => {
      const m = match.match(/(\d{3})\s+(.+)/i);
      return m ? `HTTP ${m[1]}: ${m[2]}` : match;
    },
  },

  // Warning patterns
  {
    regex: /\b(warn(ing)?|deprecated|notice|advisory)\b/i,
    severity: "warning",
    extract: (_m, line) => line.trim(),
  },

  // Info patterns
  {
    regex: /\b(info|notice|tip|hint|suggestion|recommendation)\b/i,
    severity: "info",
    extract: (_m, line) => line.trim(),
  },
];

// ---------------------------------------------------------------------------
// Suggestion patterns
// ---------------------------------------------------------------------------

const SUGGESTION_PATTERNS: RegExp[] = [
  /^\s*(try|consider|you can|you should|you may|use|run|execute|install|update|upgrade|restart|reboot|check|verify|ensure|make sure|set|configure|add|remove|delete|create|copy|move|rename)\b/i,
  /^\s*(>?\s*)?(npm|yarn|pnpm|cargo|pip|pip3|apt|apt-get|yum|dnf|brew|choco|scoop|go get|dotnet|mvn|gradle)\s+(install|add|update|upgrade|run|test|build|init)/i,
  /^\s*(Run|Try|Use|Check|Ensure|Make sure|Set|Configure|Add|Remove|Delete|Create|Copy|Move|Rename|Install|Update|Upgrade|Restart|Reboot|Verify)/i,
];

// ---------------------------------------------------------------------------
// Path extraction
// ---------------------------------------------------------------------------

const PATH_PATTERNS: RegExp[] = [
  // Absolute Unix paths
  /^(\/[^:\s]+)/,
  // Absolute Windows paths
  /^[A-Z]:\\[^:\s]+/i,
  // Relative paths (at least one / or \)
  /(?<!\s)(\.[^:\s]*\/[^:\s]+|[^:\s]*\/[^:\s]+\.\w+)/,
  // URLs
  /https?:\/\/[^:\s]+/,
];

// ---------------------------------------------------------------------------
// Exit code extraction
// ---------------------------------------------------------------------------

const EXIT_CODE_PATTERNS: RegExp[] = [
  /\b(EXIT CODE|exit code|exit status)\s*[:=]?\s*(\d+)/i,
  /\breturned\s+code\s+(\d+)/i,
  /\bexit\s+(\d+)/i,
  /\bprocess\s+exited\s+with\s+code\s+(\d+)/i,
];

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/**
 * Detects the format of the output.
 */
export function detectOutputFormat(output: string): OutputFormat {
  const trimmed = output.trim();

  // Empty output
  if (trimmed.length === 0) {
    return { _tag: "text" };
  }

  // Try JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      const depth = calculateJsonDepth(parsed);
      return { _tag: "json", valid: true, depth };
    } catch {
      return { _tag: "json", valid: false };
    }
  }

  // Check for JSONL / NDJSON
  const lines = trimmed.split("\n");
  if (lines.length > 1) {
    let jsonLines = 0;
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      if (l.startsWith("{") || l.startsWith("[")) {
        try {
          JSON.parse(l);
          jsonLines++;
        } catch {
          break;
        }
      }
    }
    if (jsonLines >= Math.min(lines.length, 3)) {
      return { _tag: "log", format: "jsonl" };
    }
  }

  // Check for stack trace
  const stackTracePatterns = [
    /^\s*at\s+.+\(.+:\d+:\d+\)/,
    /^\s*at\s+.+:\d+:\d+/,
    /^\s*File\s+".+",\s+line\s+\d+/,
    /^\s*Traceback\s+\(most recent/i,
    /^\s*thread\s+'.+'\s+panicked/i,
    /^\s*goroutine\s+\d+\s+\[/,
  ];
  let stackFrames = 0;
  for (const line of lines) {
    for (const pat of stackTracePatterns) {
      if (pat.test(line)) {
        stackFrames++;
        break;
      }
    }
  }
  if (stackFrames >= 2) {
    return { _tag: "stack-trace" };
  }

  // Check for diff
  const diffPatterns = [/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/, /^\+{3} b\//, /^-{3} a\//, /^diff --git/];
  let diffLines = 0;
  for (const line of lines) {
    for (const pat of diffPatterns) {
      if (pat.test(line)) {
        diffLines++;
        break;
      }
    }
  }
  if (diffLines >= 2) {
    return { _tag: "diff" };
  }

  // Check for table (pipe-separated or tabular)
  const pipeLines = lines.filter((l) => l.includes("|") && l.trim().startsWith("|"));
  if (pipeLines.length >= 2) {
    return { _tag: "table" };
  }

  // Check for structured log (key=value or [timestamp] pattern)
  const logPatterns = [
    /^\[\d{4}-\d{2}-\d{2}/, // [2024-01-01
    /^\d{4}-\d{2}-\d{2}T/, // 2024-01-01T
    /^\d{4}-\d{2}-\d{2} /, // 2024-01-01
    /^\d{2}:\d{2}:\d{2}/,  // 12:34:56
    /^[A-Z]{3,}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/, // Mon DD HH:MM:SS
    /^\w+=\S+/, // key=value
  ];
  let logLines = 0;
  for (const line of lines) {
    for (const pat of logPatterns) {
      if (pat.test(line)) {
        logLines++;
        break;
      }
    }
  }
  if (logLines >= Math.min(lines.length, 3)) {
    return { _tag: "log", format: "structured" };
  }

  // Default: plain text
  return { _tag: "text" };
}

/**
 * Calculates the depth of a JSON value.
 */
function calculateJsonDepth(value: unknown): number {
  if (value === null || typeof value !== "object") {
    return 0;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return 1;
    return 1 + Math.max(...value.map(calculateJsonDepth));
  }
  const keys = Object.keys(value as object);
  if (keys.length === 0) return 1;
  return 1 + Math.max(...keys.map((k) => calculateJsonDepth((value as Record<string, unknown>)[k])));
}

// ---------------------------------------------------------------------------
// Error detection
// ---------------------------------------------------------------------------

/**
 * Detects error patterns in the output.
 */
export function detectErrors(output: string): ErrorPattern[] {
  const lines = output.split("\n");
  const errors: ErrorPattern[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const def of ERROR_PATTERNS) {
      // Reset regex state for global patterns
      const regex = new RegExp(def.regex.source, def.regex.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        errors.push({
          pattern: def.regex.source,
          severity: def.severity,
          match: match[0],
          line: i + 1, // 1-based
          message: def.extract(match[0], line),
        });
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Key information extraction
// ---------------------------------------------------------------------------

/**
 * Extracts key information from the output: errors, warnings, suggestions,
 * paths, and exit codes.
 */
export function extractKeyInfo(output: string): ExtractedInfo {
  const lines = output.split("\n");
  const errors: string[] = [];
  const warnings: string[] = [];
  const suggestions: Suggestion[] = [];
  const paths: string[] = [];
  const exitCodes: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Error messages
    if (/\b(error|ERROR|exception|Exception|fatal|FATAL|panic)\b/i.test(line)) {
      errors.push(line);
    }

    // Warning messages
    if (/\b(warn(ing)?|deprecated|notice|advisory)\b/i.test(line)) {
      warnings.push(line);
    }

    // Suggestions
    for (const pat of SUGGESTION_PATTERNS) {
      if (pat.test(line)) {
        suggestions.push({ text: line, line: i + 1 });
        break;
      }
    }

    // Paths
    for (const pat of PATH_PATTERNS) {
      const match = line.match(pat);
      if (match) {
        const path = match[1] || match[0];
        if (!paths.includes(path)) {
          paths.push(path);
        }
      }
    }

    // Exit codes
    for (const pat of EXIT_CODE_PATTERNS) {
      const match = line.match(pat);
      if (match) {
        const code = parseInt(match[1], 10);
        if (!isNaN(code) && !exitCodes.includes(code)) {
          exitCodes.push(code);
        }
      }
    }
  }

  return { errors, warnings, suggestions, paths, exitCodes };
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

/**
 * Generates a summary of the output analysis.
 */
export function generateSummary(
  output: string,
  errors: ErrorPattern[],
  info: ExtractedInfo,
): AnalysisSummary {
  const lineCount = output.split("\n").length;
  const charCount = output.length;

  const hasErrors = errors.some((e) => e.severity === "error" || e.severity === "fatal");
  const hasWarnings = errors.some((e) => e.severity === "warning") || info.warnings.length > 0;
  const isSuccess = !hasErrors && !hasWarnings;

  // Generate headline
  let headline: string;
  if (hasErrors) {
    const fatalCount = errors.filter((e) => e.severity === "fatal").length;
    const errorCount = errors.filter((e) => e.severity === "error").length;
    if (fatalCount > 0) {
      headline = `Fatal error detected (${fatalCount} fatal, ${errorCount} error)`;
    } else {
      headline = `Errors detected (${errorCount} error(s))`;
    }
  } else if (hasWarnings) {
    headline = `Warnings detected (${info.warnings.length} warning(s))`;
  } else if (info.suggestions.length > 0) {
    headline = `Output contains suggestions (${info.suggestions.length} suggestion(s))`;
  } else {
    headline = isSuccess ? "Output indicates success" : "Output analyzed";
  }

  // Generate description
  let description = "";
  if (info.errors.length > 0) {
    description += `Found ${info.errors.length} error message(s). `;
  }
  if (info.warnings.length > 0) {
    description += `Found ${info.warnings.length} warning(s). `;
  }
  if (info.suggestions.length > 0) {
    description += `Found ${info.suggestions.length} suggestion(s). `;
  }
  if (info.paths.length > 0) {
    description += `Referenced ${info.paths.length} path(s). `;
  }
  if (info.exitCodes.length > 0) {
    description += `Exit code(s): ${info.exitCodes.join(", ")}. `;
  }
  if (!description) {
    description = "No significant issues detected.";
  }

  return {
    headline,
    description: description.trim(),
    isSuccess,
    hasErrors,
    hasWarnings,
    lineCount,
    charCount,
  };
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

/**
 * Analyzes tool output for errors, warnings, suggestions, and generates a
 * summary. Supports text, JSON, and log output formats.
 *
 * @param output - The tool output to analyze.
 * @param tool - Optional tool name for context.
 * @returns AnalysisResult with detected errors, extracted info, and summary.
 */
export function analyzeToolOutput(output: string, tool?: string): AnalysisResult {
  const format = detectOutputFormat(output);
  const errors = detectErrors(output);
  const info = extractKeyInfo(output);
  const summary = generateSummary(output, errors, info);

  return { format, errors, info, summary };
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Checks if the output contains any errors.
 */
export function hasErrors(output: string): boolean {
  return detectErrors(output).some((e) => e.severity === "error" || e.severity === "fatal");
}

/**
 * Checks if the output contains any warnings.
 */
export function hasWarnings(output: string): boolean {
  const errors = detectErrors(output);
  return errors.some((e) => e.severity === "warning");
}

/**
 * Gets the most severe error from the output.
 */
export function getMostSevereError(output: string): ErrorPattern | null {
  const errors = detectErrors(output);
  const severityOrder: Record<ErrorSeverity, number> = { fatal: 4, error: 3, warning: 2, info: 1 };
  let mostSevere: ErrorPattern | null = null;
  let maxSeverity = 0;
  for (const e of errors) {
    const sev = severityOrder[e.severity];
    if (sev > maxSeverity) {
      maxSeverity = sev;
      mostSevere = e;
    }
  }
  return mostSevere;
}

/**
 * Formats the analysis result as a human-readable string.
 */
export function formatAnalysisResult(result: AnalysisResult): string {
  const lines: string[] = [];

  // Header
  lines.push(`Format: ${result.format._tag}`);
  if (result.format._tag === "json") {
    lines.push(`JSON valid: ${result.format.valid}`);
  }
  if (result.format._tag === "log") {
    lines.push(`Log format: ${result.format.format}`);
  }
  lines.push("");

  // Summary
  lines.push(result.summary.headline);
  lines.push(result.summary.description);
  lines.push("");

  // Errors
  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const e of result.errors) {
      lines.push(`  [${e.severity}] Line ${e.line}: ${e.message}`);
    }
    lines.push("");
  }

  // Suggestions
  if (result.info.suggestions.length > 0) {
    lines.push("Suggestions:");
    for (const s of result.info.suggestions) {
      lines.push(`  Line ${s.line}: ${s.text}`);
    }
    lines.push("");
  }

  // Paths
  if (result.info.paths.length > 0) {
    lines.push("Paths:");
    for (const p of result.info.paths) {
      lines.push(`  ${p}`);
    }
    lines.push("");
  }

  // Exit codes
  if (result.info.exitCodes.length > 0) {
    lines.push(`Exit codes: ${result.info.exitCodes.join(", ")}`);
  }

  return lines.join("\n");
}
