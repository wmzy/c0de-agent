// Write-conflict detection for parallel tool execution (spec §2.7).
//
// Tools that can write to disk must be serialized when their target paths
// overlap. Non-write tools can always run in parallel.

/**
 * Tools that can modify files on disk.
 */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "ast_edit", "file", "bash"]);

/**
 * Extract target file paths from a tool call's parsed JSON arguments.
 * Returns `null` when the tool is not a write tool or when paths cannot
 * be determined (e.g. bash commands), signalling that the call must be
 * serialized against all other write calls.
 */
function extractTargetPaths(toolName: string, argsJson: string): string[] | null {
  if (!WRITE_TOOLS.has(toolName)) return [];

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson);
  } catch {
    // Unparseable args — serialize as a safety measure
    return null;
  }

  switch (toolName) {
    case "write":
    case "edit": {
      const p = typeof args.path === "string" ? args.path : null;
      return p !== null ? [p] : null;
    }
    case "ast_edit": {
      const paths = args.paths;
      if (Array.isArray(paths) && paths.every((p: unknown) => typeof p === "string")) {
        return paths as string[];
      }
      return null;
    }
    case "file": {
      const p = typeof args.path === "string" ? args.path : null;
      return p !== null ? [p] : null;
    }
    case "bash":
      // Bash can touch anything — serialize against all writes
      return null;
    default:
      return [];
  }
}

/**
 * Partition tool calls into parallel-safe groups.
 *
 * Returns an array of groups. Each group contains tool calls that can be
 * executed concurrently. Groups are ordered — group N must finish before
 * group N+1 starts.
 *
 * Two write tool calls conflict when they share at least one target path
 * (or when one has indeterminate paths). Non-write calls never conflict.
 */
export function partitionByWriteConflict(
  toolCalls: Array<{ id: string; name: string; args: string }>,
): Array<Array<{ id: string; name: string; args: string }>> {
  // Build a map: groupId → { calls[], paths }
  const groups: Array<{
    calls: Array<{ id: string; name: string; args: string }>;
    paths: Set<string> | null; // null = conflicts with all writes
  }> = [];

  for (const tc of toolCalls) {
    const paths = extractTargetPaths(tc.name, tc.args);

    // Non-write tool — goes into a standalone group that can run in parallel
    // with anything else non-write, but must not block write groups.
    if (paths !== null && paths.length === 0) {
      groups.push({ calls: [tc], paths: new Set() });
      continue;
    }

    // Indeterminate paths (null) — must serialize with all other writes
    if (paths === null) {
      // Find the first group that has indeterminate paths and merge
      const existing = groups.find(
        (g) => g.paths === null && g.calls.some((c) => WRITE_TOOLS.has(c.name)),
      );
      if (existing) {
        existing.calls.push(tc);
      } else {
        groups.push({ calls: [tc], paths: null });
      }
      continue;
    }

    // Deterministic paths — find a group whose paths don't overlap
    let merged = false;
    for (const group of groups) {
      if (group.paths === null) continue; // indeterminate — skip
      const overlap = paths.some((p) => group.paths!.has(p));
      if (!overlap) {
        group.calls.push(tc);
        for (const p of paths) group.paths!.add(p);
        merged = true;
        break;
      }
    }
    if (!merged) {
      const s = new Set(paths);
      groups.push({ calls: [tc], paths: s });
    }
  }

  // Separate write-groups from non-write-groups:
  // Non-write groups (paths is an empty set AND all calls are non-write)
  // can run concurrently with each other. Write groups must serialize.
  const nonWriteGroups = groups.filter((g) => g.paths !== null && g.paths.size === 0);
  const writeGroups = groups.filter((g) => !(g.paths !== null && g.paths.size === 0));

  const result: Array<Array<{ id: string; name: string; args: string }>> = [];

  // All non-write calls go into one parallel batch
  const nonWriteCalls = nonWriteGroups.flatMap((g) => g.calls);
  if (nonWriteCalls.length > 0) {
    result.push(nonWriteCalls);
  }

  // Each write group serializes
  for (const wg of writeGroups) {
    result.push(wg.calls);
  }

  return result;
}
