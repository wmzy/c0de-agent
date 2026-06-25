// Tool-pair validator (spec §tool-pair).
//
// Validates ordering constraints between tool calls to prevent unsafe
// sequences like editing a file without reading it first, or writing
// before understanding the existing content.
//
// The validator tracks a history of tool calls per agent run and checks
// each new call against pairing rules. It produces:
//   - Violations (warnings / errors) with human-readable messages
//   - Repair suggestions the agent can act on
//
// Conventions: data + functions, no class, no this.
//
// ---------------------------------------------------------------------------
// Pairing rules
// ---------------------------------------------------------------------------

/** A file path that a tool operates on. */
type TargetPath = string;

/** A recorded tool call entry for validation. */
export type ToolCallRecord = {
  name: string;
  args: string;
  paths: TargetPath[];
  timestamp: number;
};

/** Severity of a validation finding. */
export type Severity = "info" | "warning" | "error";

/** A validation finding produced by the pair validator. */
export type PairViolation = {
  /** Unique rule identifier. */
  rule: string;
  /** Human-readable description of what went wrong. */
  message: string;
  /** Severity level. */
  severity: Severity;
  /** Suggested fix the agent can apply. */
  suggestion: string;
  /** The tool call that triggered the violation. */
  tool: string;
  /** The affected file path(s), if any. */
  paths?: TargetPath[];
};

/**
 * A pairing rule defines a constraint on tool call ordering.
 *
 * Each rule has:
 *   - id: unique identifier
 *   - description: human-readable explanation
 *   - check: function that takes the current call + history and returns
 *     a violation if the rule is broken.
 */
type PairingRule = {
  id: string;
  description: string;
  check: (call: ToolCallRecord, history: ToolCallRecord[]) => PairViolation | null;
};

/**
 * State tracked per agent run for pair validation.
 */
export type PairValidatorState = {
  history: ToolCallRecord[];
  violations: PairViolation[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse tool arguments to extract target file paths.
 * Returns an empty array if the tool doesn't operate on files.
 */
function extractPaths(name: string, args: string): TargetPath[] {
  if (!args) return [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(args);
  } catch {
    return [];
  }

  switch (name) {
    case "read": {
      const p = typeof parsed.path === "string" ? parsed.path : null;
      return p ? [p] : [];
    }
    case "edit": {
      const p = typeof parsed.path === "string" ? parsed.path : null;
      return p ? [p] : [];
    }
    case "write": {
      const p = typeof parsed.path === "string" ? parsed.path : null;
      return p ? [p] : [];
    }
    case "ast_edit": {
      const paths = parsed.paths;
      if (Array.isArray(paths) && paths.every((p: unknown) => typeof p === "string")) {
        return paths as string[];
      }
      return [];
    }
    case "ast_grep": {
      const paths = parsed.paths;
      if (Array.isArray(paths) && paths.every((p: unknown) => typeof p === "string")) {
        return paths as string[];
      }
      return [];
    }
    case "glob": {
      const paths = parsed.paths;
      if (Array.isArray(paths) && paths.every((p: unknown) => typeof p === "string")) {
        return paths as string[];
      }
      return [];
    }
    case "search": {
      const paths = parsed.paths;
      if (Array.isArray(paths) && paths.every((p: unknown) => typeof p === "string")) {
        return paths as string[];
      }
      return [];
    }
    case "file": {
      const p = typeof parsed.path === "string" ? parsed.path : null;
      return p ? [p] : [];
    }
    case "bash": {
      // Bash can operate on any file; we cannot determine paths statically.
      return [];
    }
    default:
      return [];
  }
}

/**
 * Check if a path was previously read in the history.
 */
function wasReadBefore(path: string, history: ToolCallRecord[]): boolean {
  return history.some(
    (r) =>
      r.name === "read" && r.paths.some((p) => normalizePath(p) === normalizePath(path)),
  );
}

/**
 * Normalize a path for comparison (resolve ./ and trailing slashes).
 */
function normalizePath(p: string): string {
  return p.replace(/\/+$/, "").replace(/\/\.\//g, "/");
}

/**
 * Check if a path was previously searched/grepped in the history.
 */
function wasSearchedBefore(path: string, history: ToolCallRecord[]): boolean {
  return history.some(
    (r) =>
      (r.name === "search" || r.name === "ast_grep" || r.name === "glob") &&
      r.paths.some((p) => normalizePath(p) === normalizePath(path)),
  );
}

/**
 * Check if the same tool was called on the same path consecutively.
 */
function wasSameToolConsecutive(
  call: ToolCallRecord,
  history: ToolCallRecord[],
): boolean {
  if (history.length === 0) return false;
  const last = history[history.length - 1];
  return last.name === call.name && call.paths.some((p) => last.paths.includes(p));
}

// ---------------------------------------------------------------------------
// Pairing rules
// ---------------------------------------------------------------------------

/**
 * Rule: edit-before-read
 *
 * An `edit` or `write` tool should not be called on a file that has never
 * been `read` first. This prevents blind edits that may corrupt content
 * the agent doesn't understand.
 *
 * Exception: `write` on a new file (path not seen in history) is allowed.
 */
const editBeforeReadRule: PairingRule = {
  id: "edit-before-read",
  description: "Edit/write should be preceded by a read of the same file",
  check: (call, history) => {
    if (call.name !== "edit" && call.name !== "write" && call.name !== "ast_edit") {
      return null;
    }

    for (const path of call.paths) {
      if (wasReadBefore(path, history)) {
        continue; // File was read before - OK
      }

      // For `write`, check if the file is new (never seen in history)
      if (call.name === "write") {
        const everSeen = history.some((r) =>
          r.paths.some((p) => normalizePath(p) === normalizePath(path)),
        );
        if (!everSeen) {
          continue; // New file - OK to write
        }
        // File was seen before but not read - still a violation
      }

      return {
        rule: "edit-before-read",
        severity: "warning",
        message: `Tool "${call.name}" is being called on "${path}" without a prior "read" call. The agent may not have the current file content in context.`,
        suggestion: `Add a "read" call for "${path}" before editing to ensure you have the latest content.`,
        tool: call.name,
        paths: [path],
      };
    }

    return null;
  },
};

/**
 * Rule: write-after-edit
 *
 * A `write` call should not immediately follow an `edit` call on the same
 * file. The `edit` tool already modifies the file; a subsequent `write`
 * would overwrite those changes.
 */
const writeAfterEditRule: PairingRule = {
  id: "write-after-edit",
  description: "Write should not follow edit on the same file",
  check: (call, history) => {
    if (call.name !== "write") return null;

    for (const path of call.paths) {
      // Find the most recent edit on this path using index-based ordering
      // (timestamps may be identical for sequential calls)
      let editIndex = -1;
      for (let i = history.length - 1; i >= 0; i--) {
        const r = history[i];
        if (
          (r.name === "edit" || r.name === "ast_edit") &&
          r.paths.some((p) => normalizePath(p) === normalizePath(path))
        ) {
          editIndex = i;
          break;
        }
      }
      if (editIndex === -1) continue;

      // Check if there was a read after the edit (which would refresh context)
      const readAfterEdit = history.some(
        (r, idx) =>
          idx > editIndex &&
          r.name === "read" &&
          r.paths.some((p) => normalizePath(p) === normalizePath(path)),
      );
      if (readAfterEdit) continue;

      return {
        rule: "write-after-edit",
        severity: "error",
        message: `Tool "write" is being called on "${path}" immediately after an "edit" call. This would overwrite the changes made by the edit.`,
        suggestion: `Remove the "write" call or add a "read" call between them to refresh the file content.`,
        tool: "write",
        paths: [path],
      };
    }

    return null;
  },
};

/**
 * Rule: edit-without-search
 *
 * An `edit` or `ast_edit` call on a file should be preceded by a search
 * (grep, ast_grep, search) to understand the code structure being modified.
 */
const editWithoutSearchRule: PairingRule = {
  id: "edit-without-search",
  description: "Edit should be preceded by a search to understand code structure",
  check: (call, history) => {
    if (call.name !== "edit" && call.name !== "ast_edit") return null;

    for (const path of call.paths) {
      // If the file was never read, edit-before-read already covers this case
      if (wasReadBefore(path, history)) {
        // File was read but not searched — that's the case this rule catches
        if (!wasSearchedBefore(path, history)) {
          return {
            rule: "edit-without-search",
            severity: "info",
            message: `Tool "${call.name}" is being called on "${path}" without a prior "search" call. Consider understanding the code structure first.`,
            suggestion: `Add a "search" or "ast_grep" call for "${path}" before editing to understand the code structure.`,
            tool: call.name,
            paths: [path],
          };
        }
      }
      // If not read and not searched, edit-before-read already fires — skip
    }

    return null;
  },
};

/**
 * Rule: repeated-same-tool
 *
 * The same tool called on the same path consecutively is likely redundant
 * or indicates the agent is stuck.
 */
const repeatedSameToolRule: PairingRule = {
  id: "repeated-same-tool",
  description: "Same tool on same path consecutively is likely redundant",
  check: (call, history) => {
    if (!wasSameToolConsecutive(call, history)) return null;

    return {
      rule: "repeated-same-tool",
      severity: "warning",
      message: `Tool "${call.name}" is being called on the same path(s) consecutively: ${call.paths.join(", ")}. This may be redundant.`,
      suggestion: `Check if the previous call succeeded. If not, consider a different approach or add a "read" to see the current state.`,
      tool: call.name,
      paths: call.paths,
    };
  },
};

/**
 * Rule: bash-before-read
 *
 * A `bash` call that modifies files should be preceded by a read of those
 * files if they are known. This is a heuristic check.
 */
const bashBeforeReadRule: PairingRule = {
  id: "bash-before-read",
  description: "Bash file modification should be preceded by read",
  check: (call, history) => {
    if (call.name !== "bash") return null;

    // Check if the bash command is a file modification command
    const modificationPatterns = [
      /\b(sed|awk)\s.*\>/,
      /\b(echo|cat|printf)\s.*\>/,
      /\b(cp|mv|rm)\b/,
      /\b(git\s+commit)\b/,
      /\b(npm\s+install)\b/,
      /\b(pnpm\s+add)\b/,
    ];

    const isModification = modificationPatterns.some((re) => re.test(call.args));
    if (!isModification) return null;

    // Check if any known files were read before
    const knownPaths = history.flatMap((r) => r.paths);
    if (knownPaths.length === 0) return null;

    const unreadPaths = knownPaths.filter((p) => !wasReadBefore(p, history));
    if (unreadPaths.length === 0) return null;

    return {
      rule: "bash-before-read",
      severity: "info",
      message: `Bash command appears to modify files, but some known files have not been read: ${unreadPaths.join(", ")}.`,
      suggestion: `Consider reading the files before running the bash command to understand their current state.`,
      tool: "bash",
      paths: unreadPaths,
    };
  },
};

/**
 * Rule: search-after-edit
 *
 * A search on a file that was just edited may return stale results if the
 * search tool doesn't reflect the latest changes.
 */
const searchAfterEditRule: PairingRule = {
  id: "search-after-edit",
  description: "Search after edit may return stale results",
  check: (call, history) => {
    if (call.name !== "search" && call.name !== "ast_grep" && call.name !== "glob") return null;

    for (const path of call.paths) {
      const recentEdit = history.findLast(
        (r) =>
          (r.name === "edit" || r.name === "ast_edit" || r.name === "write") &&
          r.paths.some((p) => normalizePath(p) === normalizePath(path)),
      );
      if (!recentEdit) continue;

      // Check if there was a read after the edit
      const readAfterEdit = history.find(
        (r) =>
          r.name === "read" &&
          r.timestamp > recentEdit.timestamp &&
          r.paths.some((p) => normalizePath(p) === normalizePath(path)),
      );
      if (readAfterEdit) continue;

      return {
        rule: "search-after-edit",
        severity: "info",
        message: `Tool "${call.name}" is being called on "${path}" after a recent edit. The search results may not reflect the latest changes.`,
        suggestion: `Consider reading the file first to see the current state, or re-run the search after confirming the edit succeeded.`,
        tool: call.name,
        paths: [path],
      };
    }

    return null;
  },
};

/**
 * All pairing rules in order of severity.
 */
const PAIRING_RULES: PairingRule[] = [
  writeAfterEditRule, // error
  editBeforeReadRule, // warning
  repeatedSameToolRule, // warning
  editWithoutSearchRule, // info
  searchAfterEditRule, // info
  bashBeforeReadRule, // info
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a fresh pair validator state for a single agent run.
 */
export function createPairValidatorState(): PairValidatorState {
  return {
    history: [],
    violations: [],
  };
}

/**
 * Record a tool call in the validator's history.
 */
export function recordToolCall(state: PairValidatorState, name: string, args: string): void {
  const paths = extractPaths(name, args);
  state.history.push({
    name,
    args,
    paths,
    timestamp: Date.now(),
  });
}

/**
 * Validate a tool call against all pairing rules.
 * Returns an array of violations (may be empty).
 */
export function validateToolCall(
  state: PairValidatorState,
  name: string,
  args: string,
): PairViolation[] {
  const paths = extractPaths(name, args);
  const call: ToolCallRecord = {
    name,
    args,
    paths,
    timestamp: Date.now(),
  };

  const violations: PairViolation[] = [];

  for (const rule of PAIRING_RULES) {
    const violation = rule.check(call, state.history);
    if (violation) {
      violations.push(violation);
    }
  }

  // Record the call after validation (so the check sees history before this call)
  recordToolCall(state, name, args);

  return violations;
}

/**
 * Validate a batch of tool calls (e.g., from a single LLM response).
 * Returns all violations found across the batch.
 */
export function validateToolCalls(
  state: PairValidatorState,
  calls: Array<{ name: string; args: string }>,
): PairViolation[] {
  const allViolations: PairViolation[] = [];

  for (const call of calls) {
    const violations = validateToolCall(state, call.name, call.args);
    allViolations.push(...violations);
  }

  return allViolations;
}

/**
 * Get all violations accumulated so far in the session.
 */
export function getViolations(state: PairValidatorState): PairViolation[] {
  return [...state.violations];
}

/**
 * Get the tool call history for debugging/inspection.
 */
export function getHistory(state: PairValidatorState): ToolCallRecord[] {
  return [...state.history];
}

/**
 * Format violations as a human-readable string for agent feedback.
 */
export function formatViolations(violations: PairViolation[]): string {
  if (violations.length === 0) return "";

  const lines = violations.map((v) => {
    const prefix = v.severity === "error" ? "❌" : v.severity === "warning" ? "⚠️" : "ℹ️";
    return `${prefix} [${v.rule}] ${v.message}\n   Suggestion: ${v.suggestion}`;
  });

  return `Tool pair validation findings:\n${lines.join("\n")}`;
}

/**
 * Check if any violation is critical (error severity).
 */
export function hasCriticalViolation(violations: PairViolation[]): boolean {
  return violations.some((v) => v.severity === "error");
}