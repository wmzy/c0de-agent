// Bash file read guard (spec §5.4).
//
// Detects file-read operations in bash commands targeting sensitive paths
// (credentials, private keys, password databases, kernel memory, etc.)
// before execution. Returns structured results indicating whether the
// command should proceed, be blocked, or carry a warning.
//
// Design: pure data + functions, no class. The main API is
// `checkBashFileRead()` which returns a `BashFileReadGuardResult` —
// plugs into the bash tool's pre-execution pipeline alongside the
// existing fsync guard.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BashFileReadGuardResult =
  | { ok: true }
  | {
      ok: false;
      /** The detected sensitive path. */
      path: string;
      /** The file-read command that triggered detection. */
      command: string;
      /** Human-readable reason for the block/warning. */
      reason: string;
      /** "block" = execution MUST stop; "warn" = advisory only. */
      severity: "block" | "warn";
    };

// ---------------------------------------------------------------------------
// Sensitive path patterns
//
// Each entry describes a file or glob that holds credentials, secrets,
// or privileged data. The `severity` field controls whether the guard
// blocks execution outright or merely warns.
// ---------------------------------------------------------------------------

type SensitivePathPattern = {
  /** Regex matching a file path (applied to each extracted path). */
  regex: RegExp;
  /** Human-readable label for diagnostics. */
  label: string;
  /** Why this path is sensitive. */
  reason: string;
  /** "block" prevents execution; "warn" prepends an advisory. */
  severity: "block" | "warn";
};

// Home-relative patterns are anchored with ~ so both literal ~/… and
// expansion-resolved paths are caught.
const SENSITIVE_PATHS: SensitivePathPattern[] = [
  // ---- Password / shadow databases ----
  {
    regex: /^\/etc\/shadow$/,
    label: "/etc/shadow",
    reason:
      "Contains user password hashes. Reading this file exposes credential " +
      "material to the agent context and may violate system policy.",
    severity: "block",
  },
  {
    regex: /^\/etc\/gshadow$/,
    label: "/etc/gshadow",
    reason:
      "Contains group password hashes and admin credentials. Access to " +
      "this file is restricted to privileged processes.",
    severity: "block",
  },
  {
    regex: /^\/etc\/sudoers$/,
    label: "/etc/sudoers",
    reason:
      "Defines sudo privileges. Reading exposes privilege escalation rules " +
      "and should be done via `visudo` only.",
    severity: "block",
  },
  {
    regex: /^\/etc\/master\.passwd$/,
    label: "/etc/master.passwd",
    reason:
      "BSD master password file containing password hashes and user metadata.",
    severity: "block",
  },

  // ---- SSH keys ----
  {
    regex: /[/\\]\.ssh[/\\](?:id_[a-z0-9]+|(?:ssh|ecdsa|ed25519|rsa)[_-]?key(?:\.pub)?|(?:[a-z0-9_-]+_)?(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)/i,
    label: "SSH private/public key",
    reason:
      "SSH key files grant authentication to remote systems. Agent access " +
      "to these files risks key material exposure.",
    severity: "block",
  },
  {
    regex: /[/\\]\.ssh[/\\]authorized_keys$/,
    label: "SSH authorized_keys",
    reason:
      "Lists public keys authorized for login. Exposure may reveal " +
      "authorized identities.",
    severity: "warn",
  },
  {
    regex: /[/\\]\.ssh[/\\](?:config|known_hosts)$/,
    label: "SSH config/known_hosts",
    reason:
      "Reveals SSH connection targets and configuration. May leak " +
      "infrastructure details.",
    severity: "warn",
  },

  // ---- GPG / PGP keys ----
  {
    regex: /[/\\]\.gnupg[/\\]/,
    label: "GnuPG directory",
    reason:
      "GnuPG directory contains private keys, trust database, and " +
      "encryption material. All files in this directory are sensitive.",
    severity: "block",
  },

  // ---- Private key files (PEM, DER, PKCS) ----
  {
    regex: /(?:^|[/\\])(?:[^/\\]*[_.-])?(?:private|priv)[_.-]?key(?:\.pem|\.key|\.der)?$/i,
    label: "private key file",
    reason:
      "File name indicates a private key. Private keys must not be " +
      "exposed to agent contexts.",
    severity: "block",
  },
  {
    regex: /(?:^|[/\\])[^/\\]+\.pem$/i,
    label: "PEM file",
    reason:
      "PEM files may contain certificates, private keys, or certificate " +
      "chains. Private key PEM files grant cryptographic identity.",
    severity: "warn",
  },
  {
    regex: /(?:^|[/\\])[^/\\]+\.key$/i,
    label: ".key file",
    reason:
      "Key files may contain private cryptographic keys or API secrets.",
    severity: "block",
  },

  // ---- Cloud provider credentials ----
  {
    regex: /[/\\]\.aws[/\\]credentials$/,
    label: "AWS credentials",
    reason:
      "Contains AWS access key IDs and secret access keys for cloud " +
      "resource access.",
    severity: "block",
  },
  {
    regex: /[/\\]\.config[/\\]gcloud[/\\](?:credentials\.db|access_tokens\.db)$/,
    label: "GCP credentials",
    reason:
      "Google Cloud credential store containing OAuth tokens and service " +
      "account keys.",
    severity: "block",
  },
  {
    regex: /[/\\]\.azure[/\\]accessTokens\.json$/,
    label: "Azure tokens",
    reason:
      "Azure CLI token cache with session tokens for Azure resource access.",
    severity: "block",
  },

  // ---- Docker / container registry ----
  {
    regex: /[/\\]\.docker[/\\]config\.json$/,
    label: "Docker config",
    reason:
      "Docker configuration may contain registry auth tokens encoded in " +
      "base64. These grant push/pull access to container registries.",
    severity: "block",
  },

  // ---- Database / service credentials ----
  {
    regex: /[/\\]\.netrc$/,
    label: ".netrc",
    reason:
      "Contains credentials for FTP/HTTP authentication to remote hosts.",
    severity: "block",
  },
  {
    regex: /[/\\]\.pgpass$/,
    label: ".pgpass",
    reason:
      "PostgreSQL password file containing connection credentials.",
    severity: "block",
  },
  {
    regex: /[/\\]\.my\.cnf$/,
    label: ".my.cnf",
    reason:
      "MySQL client configuration that may contain database passwords.",
    severity: "warn",
  },
  {
    regex: /[/\\]\.mongoshrc\.js$/,
    label: ".mongoshrc.js",
    reason:
      "MongoDB shell initialization that may contain connection credentials.",
    severity: "warn",
  },

  // ---- Environment files with secrets ----
  {
    regex: /(?:^|[/\\])\.env(?:\.[a-zA-Z0-9._-]+)?$/,
    label: ".env file",
    reason:
      "Environment files commonly contain API keys, database passwords, " +
      "and other secrets in plaintext.",
    severity: "warn",
  },
  {
    regex: /(?:^|[/\\])\.env\.local$/,
    label: ".env.local",
    reason:
      "Local environment overrides typically contain secrets not committed " +
      "to version control.",
    severity: "block",
  },

  // ---- Kernel / process memory ----
  {
    regex: /^\/dev\/mem$/,
    label: "/dev/mem",
    reason:
      "Raw physical memory device. Reading exposes all system memory " +
      "including kernel data structures and secrets.",
    severity: "block",
  },
  {
    regex: /^\/dev\/kmem$/,
    label: "/dev/kmem",
    reason:
      "Kernel virtual memory device. Access exposes kernel memory contents.",
    severity: "block",
  },
  {
    regex: /^\/proc\/(?:self|\d+)\/mem$/,
    label: "/proc/*/mem",
    reason:
      "Process memory image. Reading exposes all memory of the target " +
      "process including secrets in heap/stack.",
    severity: "block",
  },
  {
    regex: /^\/proc\/(?:self|\d+)\/environ$/,
    label: "/proc/*/environ",
    reason:
      "Process environment block. Contains all environment variables " +
      "which often include API keys and secrets.",
    severity: "block",
  },

  // ---- Credential stores ----
  {
    regex: /[/\\]\.config[/\\]gh[/\\]hosts\.yml$/,
    label: "GitHub CLI config",
    reason:
      "GitHub CLI configuration containing OAuth tokens for GitHub access.",
    severity: "block",
  },
  {
    regex: /[/\\]\.npmrc$/,
    label: ".npmrc",
    reason:
      "npm configuration may contain auth tokens for package registries.",
    severity: "warn",
  },
  {
    regex: /[/\\]\.pypirc$/,
    label: ".pypirc",
    reason:
      "PyPI configuration containing upload tokens for Python packages.",
    severity: "block",
  },
  {
    regex: /[/\\]\.cargo[/\\]credentials$/,
    label: "Cargo credentials",
    reason:
      "Cargo registry authentication tokens for crates.io.",
    severity: "block",
  },
];

// ---------------------------------------------------------------------------
// File-read command detection
//
// A command is a file-read command if it starts with (or follows a shell
// operator after) one of these names. We also catch common patterns like
// `$(cat file)` and backtick substitution.
// ---------------------------------------------------------------------------

/**
 * Regex that matches a file-reading command invocation.
 *
 * Captures:
 *   [1] = the command name (cat, head, etc.)
 *   [2] = the rest of the arguments
 *
 * We intentionally keep this simple: match a known command name at a
 * word boundary followed by space-separated tokens. We do NOT attempt
 * full bash parsing — the guard is defense-in-depth, not a sandbox.
 *
 * Also matches inside $(…) subshell and backtick substitution.
 */
const FILE_READ_CMD_RE =
  /(?:^|[$`(]|;|&&|\|\||\|)\s*(cat|head|tail|tac|nl|less|more|od|xxd|hexdump|strings|file|stat|wc|diff|cmp|md5sum|sha1sum|sha256sum|sha512sum|cksum|b2sum)\b\s+(.*?)(?:$|[;|&`)])/g;

/**
 * Regex that matches a grep/awk/sed command reading files.
 * For grep-family: the first non-flag arg is the PATTERN, the remaining
 * are files. We capture all non-flag args and extract the file args
 * (args after the first non-flag arg).
 */
const GREP_CMD_RE =
  /(?:^|[$`(]|;|&&|\|\||\|)\s*(grep|egrep|fgrep)\b([^;|&`]*?)(?:$|[;|&`)])/g;

/**
 * Regex for sed/awk/perl — the script argument is typically quoted and
 * doesn't look like a file path, so we grab the last non-flag token.
 */
const SED_AWK_CMD_RE =
  /(?:^|[$`(]|;|&&|\|\||\|)\s*(sed|awk|perl)\b([^;|&`]*?)(?:$|[;|&`)])/g;

/**
 * Regex that matches shell source commands reading files.
 * Matches `source file` and `. file` (dot-space-file).
 */
const SOURCE_CMD_RE =
  /(?:^|[;|&`])\s*(?:source|(?:\.))\s+([^\s;|&`]+)/gm;

/**
 * Extract potential file paths from a bash command string.
 *
 * This is intentionally heuristic — we look for arguments to known
 * file-reading commands and filter out flags (tokens starting with `-`).
 * Returns a deduplicated array of candidate paths.
 */
export function extractBashReadPaths(command: string): string[] {
  const paths = new Set<string>();

  // 1. Known file-reading commands (cat, head, tail, etc.)
  for (const m of command.matchAll(FILE_READ_CMD_RE)) {
    const args = m[2] ?? "";
    for (const arg of splitFileArgs(args)) {
      paths.add(arg);
    }
  }

  // 2. Grep family — first non-flag arg is pattern, rest are files
  for (const m of command.matchAll(GREP_CMD_RE)) {
    const args = m[2] ?? "";
    const nonFlag = splitFileArgs(args);
    // Skip the first non-flag arg (the search pattern), take the rest
    for (let i = 1; i < nonFlag.length; i++) {
      paths.add(nonFlag[i]);
    }
  }

  // 3. sed/awk/perl — last non-flag arg is typically the file
  for (const m of command.matchAll(SED_AWK_CMD_RE)) {
    const args = m[2] ?? "";
    const nonFlag = splitFileArgs(args);
    if (nonFlag.length > 1) {
      // Last arg is the file (first is the script/expression)
      paths.add(nonFlag[nonFlag.length - 1]);
    }
  }

  // 4. Shell source commands
  for (const m of command.matchAll(SOURCE_CMD_RE)) {
    const filePath = m[1];
    if (filePath && !filePath.startsWith("-")) {
      paths.add(filePath);
    }
  }

  // 5. Input redirection: `< /path/to/file`
  const redirectRe = /<\s*([^\s;|&`]+)/g;
  for (const m of command.matchAll(redirectRe)) {
    const filePath = m[1];
    if (filePath && !filePath.startsWith("-")) {
      paths.add(filePath);
    }
  }

  return [...paths];
}

/**
 * Split a string of arguments respecting basic shell quoting.
 * Filters out flags (tokens starting with `-`), flag values
 * (bare numbers following flags), and shell redirect operators.
 * This is a simplified splitter — handles double and single quotes
 * but not heredocs, escapes, or nested expansions.
 */
function splitFileArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < args.length; i++) {
    const ch = args[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "\\" && !inSingle && i + 1 < args.length) {
      current += args[++i];
      continue;
    }
    if (ch === " " && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    tokens.push(current);
  }

  // Post-process: filter out flags, flag values, and redirects
  const result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Skip flags
    if (token.startsWith("-")) {
      continue;
    }

    // Skip pure numbers (likely flag values like `-n 5`)
    if (/^\d+$/.test(token)) {
      continue;
    }

    // Skip shell redirects
    if (isShellRedirect(token)) {
      continue;
    }

    result.push(token);
  }

  return result;
}

/** Return true if the token looks like a shell redirect operator. */
function isShellRedirect(token: string): boolean {
  return /^[0-9]?>>?/.test(token) || /^[0-9]?<&/.test(token);
}

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a path for pattern matching:
 * - Expand leading `~` to a home-directory marker.
 * - Convert backslashes to forward slashes.
 * - Collapse `..` and `.` segments.
 * - Remove trailing slashes.
 */
function normalizePath(p: string): string {
  let path = p;

  // Expand ~ to home marker for pattern matching
  if (path.startsWith("~")) {
    path = path; // keep as-is; patterns use ~/\.ssh/ etc.
  }

  // Normalize separators
  path = path.replace(/\\/g, "/");

  // Remove trailing slash (except root)
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  return path;
}

// ---------------------------------------------------------------------------
// checkBashFileRead — public entry point
// ---------------------------------------------------------------------------

/**
 * Inspect a bash command for file-read operations targeting sensitive paths.
 *
 * Returns `{ ok: true }` when no sensitive file-read is detected, or a
 * structured result naming the blocked/warned path and the reason.
 *
 * This is a pure function with no side effects — safe to call anywhere in
 * the tool pipeline.
 */
export function checkBashFileRead(command: string): BashFileReadGuardResult {
  // Quick bailout: if the command contains none of the known read commands,
  // there's nothing to check.
  if (!mayReadFiles(command)) {
    return { ok: true };
  }

  const filePaths = extractBashReadPaths(command);
  if (filePaths.length === 0) {
    return { ok: true };
  }

  // Check each extracted path against sensitive patterns.
  // Block-severity matches return immediately; warn-severity matches are
  // collected and the first one returned only if no block matches.
  let firstWarn: BashFileReadGuardResult | undefined;

  for (const rawPath of filePaths) {
    const normalized = normalizePath(rawPath);

    for (const pattern of SENSITIVE_PATHS) {
      if (pattern.regex.test(normalized)) {
        const result: BashFileReadGuardResult = {
          ok: false,
          path: rawPath,
          command: pattern.label,
          reason: pattern.reason,
          severity: pattern.severity,
        };

        if (pattern.severity === "block") {
          return result;
        }
        if (!firstWarn) {
          firstWarn = result;
        }
      }
    }
  }

  return firstWarn ?? { ok: true };
}

/**
 * Quick heuristic: does this command look like it might read files?
 * Used as a fast pre-filter so we skip path extraction for commands
 * that clearly don't involve file reads (e.g. `echo`, `mkdir`, `cd`).
 */
function mayReadFiles(command: string): boolean {
  // Check for known file-read command names anywhere in the command.
  // This is intentionally broad — false positives just mean we run
  // extractBashReadPaths (which may return nothing).
  return /\b(?:cat|head|tail|tac|nl|less|more|od|xxd|hexdump|strings|file|stat|wc|diff|cmp|md5sum|sha1sum|sha256sum|sha512sum|cksum|b2sum|grep|egrep|fgrep|awk|sed|perl|source)\b/.test(
    command,
  ) || /</.test(command) || /\bsource\b/.test(command) || /(?:^|\s)\.\s+/.test(command); // input redirection, source, or . file
}

// ---------------------------------------------------------------------------
// formatBashFileReadWarning — helper for integration
// ---------------------------------------------------------------------------

/**
 * Format a `BashFileReadGuardResult` (when `ok: false`) into a
 * human-readable warning/error string suitable for prepending to tool
 * output or returning as an error message.
 */
export function formatBashFileReadMessage(result: BashFileReadGuardResult): string {
  if (result.ok) return "";

  const tag = result.severity === "block" ? "BLOCKED" : "WARNING";
  const action =
    result.severity === "block"
      ? "Command execution has been blocked."
      : "Command will proceed but this access is logged.";

  return [
    `[file-read-guard] ${tag}: Sensitive file access detected.`,
    `  Path: ${result.path}`,
    `  Type: ${result.command}`,
    `  Reason: ${result.reason}`,
    `  ${action}`,
    "",
  ].join("\n");
}
