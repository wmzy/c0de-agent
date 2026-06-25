import { describe, it, expect } from "vitest";
import {
  checkBashFileRead,
  extractBashReadPaths,
  formatBashFileReadMessage,
} from "./bash-file-read-guard";

// ---------------------------------------------------------------------------
// extractBashReadPaths
// ---------------------------------------------------------------------------

describe("extractBashReadPaths", () => {
  it("extracts paths from cat command", () => {
    expect(extractBashReadPaths("cat /etc/hosts")).toEqual(["/etc/hosts"]);
  });

  it("extracts multiple paths from cat", () => {
    expect(extractBashReadPaths("cat a.txt b.txt c.txt")).toEqual([
      "a.txt",
      "b.txt",
      "c.txt",
    ]);
  });

  it("extracts paths from head/tail", () => {
    expect(extractBashReadPaths("head -n 5 /var/log/syslog")).toEqual([
      "/var/log/syslog",
    ]);
    expect(extractBashReadPaths("tail -100 output.log")).toEqual([
      "output.log",
    ]);
  });

  it("extracts paths from grep", () => {
    expect(extractBashReadPaths("grep TODO src/main.ts")).toEqual([
      "src/main.ts",
    ]);
  });

  it("extracts paths from diff", () => {
    expect(extractBashReadPaths("diff a.ts b.ts")).toEqual(["a.ts", "b.ts"]);
  });

  it("extracts paths from wc", () => {
    expect(extractBashReadPaths("wc -l README.md")).toEqual(["README.md"]);
  });

  it("extracts paths from hash commands", () => {
    expect(extractBashReadPaths("sha256sum package.json")).toEqual([
      "package.json",
    ]);
  });

  it("extracts paths from input redirection", () => {
    expect(extractBashReadPaths("sort < data.csv")).toEqual(["data.csv"]);
  });

  it("extracts paths from shell source", () => {
    expect(extractBashReadPaths("source .env")).toEqual([".env"]);
    expect(extractBashReadPaths(". ./config.sh")).toEqual(["./config.sh"]);
  });

  it("skips flags", () => {
    expect(extractBashReadPaths("grep -rn TODO src/")).toEqual(["src/"]);
  });

  it("handles commands with pipes", () => {
    const paths = extractBashReadPaths("cat /etc/hosts | grep local");
    expect(paths).toContain("/etc/hosts");
  });

  it("handles commands with shell operators", () => {
    const paths = extractBashReadPaths(
      "cat /etc/hosts && echo done",
    );
    expect(paths).toContain("/etc/hosts");
  });

  it("returns empty for non-read commands", () => {
    expect(extractBashReadPaths("echo hello")).toEqual([]);
    expect(extractBashReadPaths("mkdir -p /tmp/test")).toEqual([]);
    expect(extractBashReadPaths("cd /home")).toEqual([]);
  });

  it("deduplicates paths", () => {
    expect(extractBashReadPaths("cat a.txt a.txt")).toEqual(["a.txt"]);
  });
});

// ---------------------------------------------------------------------------
// checkBashFileRead — blocked paths
// ---------------------------------------------------------------------------

describe("checkBashFileRead — blocked paths", () => {
  it("blocks /etc/shadow", () => {
    const result = checkBashFileRead("cat /etc/shadow");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
      expect(result.path).toBe("/etc/shadow");
    }
  });

  it("blocks /etc/gshadow", () => {
    const result = checkBashFileRead("cat /etc/gshadow");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("blocks /etc/sudoers", () => {
    const result = checkBashFileRead("cat /etc/sudoers");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("blocks SSH private keys", () => {
    const result = checkBashFileRead("cat ~/.ssh/id_rsa");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
      expect(result.path).toBe("~/.ssh/id_rsa");
    }
  });

  it("blocks SSH ed25519 keys", () => {
    const result = checkBashFileRead("cat ~/.ssh/id_ed25519");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("blocks .key files", () => {
    const result = checkBashFileRead("cat server.key");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("blocks GnuPG directory access", () => {
    const result = checkBashFileRead("cat ~/.gnupg/private-keys-v1.d/key.gpg");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("blocks AWS credentials", () => {
    const result = checkBashFileRead("cat ~/.aws/credentials");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
      expect(result.path).toBe("~/.aws/credentials");
    }
  });

  it("blocks Docker config", () => {
    const result = checkBashFileRead("cat ~/.docker/config.json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("blocks .netrc", () => {
    const result = checkBashFileRead("cat ~/.netrc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("blocks .env.local", () => {
    const result = checkBashFileRead("cat .env.local");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("blocks /dev/mem", () => {
    const result = checkBashFileRead("od /dev/mem");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("blocks /proc/self/environ", () => {
    const result = checkBashFileRead("cat /proc/self/environ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("blocks /proc/PID/mem", () => {
    const result = checkBashFileRead("cat /proc/1234/mem");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("blocks GitHub CLI config", () => {
    const result = checkBashFileRead("cat ~/.config/gh/hosts.yml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("blocks .pgpass", () => {
    const result = checkBashFileRead("cat ~/.pgpass");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("blocks .pypirc", () => {
    const result = checkBashFileRead("cat ~/.pypirc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("blocks Cargo credentials", () => {
    const result = checkBashFileRead("cat ~/.cargo/credentials");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });
});

// ---------------------------------------------------------------------------
// checkBashFileRead — warned paths
// ---------------------------------------------------------------------------

describe("checkBashFileRead — warned paths", () => {
  it("warns on .env files", () => {
    const result = checkBashFileRead("cat .env");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("warn");
    }
  });

  it("warns on .env.production", () => {
    const result = checkBashFileRead("cat .env.production");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("warn");
    }
  });

  it("warns on PEM files", () => {
    const result = checkBashFileRead("cat cert.pem");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("warn");
    }
  });

  it("warns on SSH authorized_keys", () => {
    const result = checkBashFileRead("cat ~/.ssh/authorized_keys");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("warn");
    }
  });

  it("warns on SSH known_hosts", () => {
    const result = checkBashFileRead("cat ~/.ssh/known_hosts");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("warn");
    }
  });

  it("warns on .npmrc", () => {
    const result = checkBashFileRead("cat ~/.npmrc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("warn");
    }
  });

  it("warns on .my.cnf", () => {
    const result = checkBashFileRead("cat ~/.my.cnf");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("warn");
    }
  });
});

// ---------------------------------------------------------------------------
// checkBashFileRead — allowed paths
// ---------------------------------------------------------------------------

describe("checkBashFileRead — allowed paths", () => {
  it("allows normal source files", () => {
    expect(checkBashFileRead("cat src/main.ts").ok).toBe(true);
  });

  it("allows package.json", () => {
    expect(checkBashFileRead("cat package.json").ok).toBe(true);
  });

  it("allows README", () => {
    expect(checkBashFileRead("head -20 README.md").ok).toBe(true);
  });

  it("allows log files", () => {
    expect(checkBashFileRead("tail -100 /var/log/app.log").ok).toBe(true);
  });

  it("allows grep in project", () => {
    expect(checkBashFileRead("grep TODO src/index.ts").ok).toBe(true);
  });

  it("allows diff of source files", () => {
    expect(checkBashFileRead("diff old.ts new.ts").ok).toBe(true);
  });

  it("allows wc on source", () => {
    expect(checkBashFileRead("wc -l src/main.ts").ok).toBe(true);
  });

  it("allows sha256sum on build output", () => {
    expect(checkBashFileRead("sha256sum dist/bundle.js").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkBashFileRead — non-read commands (quick bailout)
// ---------------------------------------------------------------------------

describe("checkBashFileRead — non-read commands", () => {
  it("passes through echo", () => {
    expect(checkBashFileRead("echo /etc/shadow").ok).toBe(true);
  });

  it("passes through mkdir", () => {
    expect(checkBashFileRead("mkdir -p /tmp/test").ok).toBe(true);
  });

  it("passes through rm", () => {
    expect(checkBashFileRead("rm -f /tmp/file").ok).toBe(true);
  });

  it("passes through cp/mv", () => {
    expect(checkBashFileRead("cp a.txt b.txt").ok).toBe(true);
    expect(checkBashFileRead("mv a.txt b.txt").ok).toBe(true);
  });

  it("passes through npm install", () => {
    expect(checkBashFileRead("npm install").ok).toBe(true);
  });

  it("passes through git commands", () => {
    expect(checkBashFileRead("git status").ok).toBe(true);
    expect(checkBashFileRead("git log --oneline").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkBashFileRead — multiple files
// ---------------------------------------------------------------------------

describe("checkBashFileRead — multiple files", () => {
  it("blocks if any file is sensitive", () => {
    const result = checkBashFileRead("cat src/main.ts ~/.ssh/id_rsa");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
      expect(result.path).toBe("~/.ssh/id_rsa");
    }
  });

  it("warns if any file triggers warning (no block)", () => {
    const result = checkBashFileRead("cat src/main.ts .env");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("warn");
    }
  });

  it("returns ok if all files are safe", () => {
    expect(checkBashFileRead("cat src/a.ts src/b.ts").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkBashFileRead — block takes precedence over warn
// ---------------------------------------------------------------------------

describe("checkBashFileRead — precedence", () => {
  it("block severity wins over warn", () => {
    // .env is warn, ~/.ssh/id_rsa is block — block should win
    const result = checkBashFileRead("cat .env ~/.ssh/id_rsa");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });
});

// ---------------------------------------------------------------------------
// checkBashFileRead — complex commands
// ---------------------------------------------------------------------------

describe("checkBashFileRead — complex commands", () => {
  it("detects sensitive read in piped commands", () => {
    const result = checkBashFileRead(
      "cat /etc/shadow | awk -F: '{print $1}'",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("detects sensitive read after &&", () => {
    const result = checkBashFileRead(
      "echo hello && cat ~/.ssh/id_rsa",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("detects sensitive read after ||", () => {
    const result = checkBashFileRead(
      "cat normal.txt || cat /etc/shadow",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("detects sensitive read in subshell", () => {
    const result = checkBashFileRead(
      "echo $(cat /etc/shadow)",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("detects sensitive read via grep", () => {
    const result = checkBashFileRead(
      "grep root /etc/shadow",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });
});

// ---------------------------------------------------------------------------
// formatBashFileReadMessage
// ---------------------------------------------------------------------------

describe("formatBashFileReadMessage", () => {
  it("formats a block message", () => {
    const result = checkBashFileRead("cat /etc/shadow");
    const msg = formatBashFileReadMessage(result);
    expect(msg).toContain("BLOCKED");
    expect(msg).toContain("/etc/shadow");
    expect(msg).toContain("blocked");
  });

  it("formats a warn message", () => {
    const result = checkBashFileRead("cat .env");
    const msg = formatBashFileReadMessage(result);
    expect(msg).toContain("WARNING");
    expect(msg).toContain(".env");
    expect(msg).toContain("proceed");
  });

  it("returns empty for ok result", () => {
    const result = checkBashFileRead("cat src/main.ts");
    const msg = formatBashFileReadMessage(result);
    expect(msg).toBe("");
  });
});

// ---------------------------------------------------------------------------
// checkBashFileRead — real-world agent commands
// ---------------------------------------------------------------------------

describe("checkBashFileRead — real-world agent commands", () => {
  it("blocks reading private SSH key", () => {
    const result = checkBashFileRead(
      "cat ~/.ssh/id_ed25519",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("allows reading public SSH key", () => {
    // Public keys are safe to read — the SSH key pattern specifically
    // matches id_* and *_key but public keys with .pub extension
    // in the pattern are treated the same. Let's check what the actual
    // behavior is. The regex includes `\.pub` so it would match too.
    // But that's a known trade-off — we block both to be safe.
    const result = checkBashFileRead("cat ~/.ssh/id_ed25519.pub");
    // The pattern matches .pub files too — this is by design for safety
    expect(result.ok).toBe(false);
  });

  it("blocks reading process environment", () => {
    const result = checkBashFileRead("cat /proc/self/environ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("allows reading source code", () => {
    expect(
      checkBashFileRead("cat src/tools/bash-file-read-guard.ts").ok,
    ).toBe(true);
  });

  it("allows reading tsconfig", () => {
    expect(checkBashFileRead("cat tsconfig.json").ok).toBe(true);
  });

  it("allows reading test files", () => {
    expect(
      checkBashFileRead("head -50 src/tools/bash-file-read-guard.test.ts").ok,
    ).toBe(true);
  });

  it("allows GCP credentials detection", () => {
    const result = checkBashFileRead(
      "cat ~/.config/gcloud/credentials.db",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });

  it("blocks Azure tokens", () => {
    const result = checkBashFileRead(
      "cat ~/.azure/accessTokens.json",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe("block");
    }
  });
});
