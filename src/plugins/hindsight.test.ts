// Hindsight plugin tests.
//
// Verifies:
//   - recordHindsight stores entries and deduplicates
//   - getHindsight returns entries sorted by recency with filters
//   - deriveLesson produces actionable advice for known error patterns
//   - formatHindsightInjection produces valid system message text
//   - createHindsightPlugin registers tool:after and message:before hooks

import { describe, expect, it, afterEach } from "vitest";

import {
  recordHindsight,
  getHindsight,
  clearHindsight,
  getSessionEntries,
  setHindsightSession,
  createHindsightPlugin,
  type HindsightEntry,
} from "./hindsight";
import { createPluginRegistry } from "./registry";
import { registerHook, runHooks } from "./hooks";
import type { PluginContext, HookMap } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(registry: ReturnType<typeof createPluginRegistry>): PluginContext {
  return {
    registerTool: () => {},
    registerProvider: () => {},
    registerHook: (hook, handler) => {
      registerHook(registry, hook as keyof HookMap, handler as any);
    },
    getConfig: () => ({} as any),
    getLogger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  };
}

// ---------------------------------------------------------------------------
// recordHindsight / getHindsight
// ---------------------------------------------------------------------------

describe("recordHindsight", () => {
  afterEach(() => {
    clearHindsight("test-session");
  });

  it("stores an entry with timestamp", async () => {
    const entry = {
      action: "read(src/foo.ts)",
      outcome: "ENOENT: no such file",
      lesson: "File not found — verify path before retrying.",
    };
    await recordHindsight("test-session", entry);
    const entries = await getHindsight({ sessionId: "test-session" });
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe(entry.action);
    expect(entries[0].outcome).toBe(entry.outcome);
    expect(entries[0].lesson).toBe(entry.lesson);
    expect(entries[0].timestamp).toBeGreaterThan(0);
  });

  it("deduplicates identical (action, outcome) pairs", async () => {
    const entry = {
      action: "edit(src/foo.ts)",
      outcome: "old_text not found",
      lesson: "Re-read before retrying.",
    };
    await recordHindsight("test-session", entry);
    await recordHindsight("test-session", entry);
    const entries = await getHindsight({ sessionId: "test-session" });
    expect(entries).toHaveLength(1);
  });

  it("allows different lessons for same action", async () => {
    await recordHindsight("test-session", {
      action: "bash(npm install)",
      outcome: "timeout",
      lesson: "Network slow — retry with longer timeout.",
    });
    await recordHindsight("test-session", {
      action: "bash(npm install)",
      outcome: "permission denied",
      lesson: "Run with sudo or fix permissions.",
    });
    const entries = await getHindsight({ sessionId: "test-session" });
    expect(entries).toHaveLength(2);
  });

  it("returns entries sorted by recency (most recent first)", async () => {
    await recordHindsight("test-session", {
      action: "read(a.ts)",
      outcome: "not found",
      lesson: "Check path.",
    });
    await new Promise((r) => setTimeout(r, 10));
    await recordHindsight("test-session", {
      action: "write(b.ts)",
      outcome: "permission denied",
      lesson: "Fix permissions.",
    });
    const entries = await getHindsight({ sessionId: "test-session" });
    expect(entries[0].action).toBe("write(b.ts)");
    expect(entries[1].action).toBe("read(a.ts)");
  });
});

describe("getHindsight", () => {
  afterEach(() => {
    clearHindsight("test-session");
  });

  it("filters by tool name", async () => {
    await recordHindsight("test-session", {
      action: "read(src/foo.ts)",
      outcome: "not found",
      lesson: "Check path.",
    });
    await recordHindsight("test-session", {
      action: "bash(npm install)",
      outcome: "timeout",
      lesson: "Retry.",
    });
    const entries = await getHindsight({ sessionId: "test-session", tool: "bash" });
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toContain("bash");
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await recordHindsight("test-session", {
        action: `read(file${i}.ts)`,
        outcome: "not found",
        lesson: `Lesson ${i}`,
      });
    }
    const entries = await getHindsight({ sessionId: "test-session", limit: 2 });
    expect(entries).toHaveLength(2);
  });

  it("returns empty array for unknown session", async () => {
    const entries = await getHindsight({ sessionId: "nonexistent" });
    expect(entries).toHaveLength(0);
  });
});

describe("getSessionEntries", () => {
  afterEach(() => {
    clearHindsight("test-session");
  });

  it("returns raw entries for a session", () => {
    recordHindsight("test-session", {
      action: "read(a.ts)",
      outcome: "not found",
      lesson: "Check path.",
    });
    const entries = getSessionEntries("test-session");
    expect(entries).toHaveLength(1);
  });
});

describe("clearHindsight", () => {
  it("removes all entries for a session", async () => {
    await recordHindsight("test-session", {
      action: "read(a.ts)",
      outcome: "not found",
      lesson: "Check path.",
    });
    clearHindsight("test-session");
    const entries = await getHindsight({ sessionId: "test-session" });
    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deriveLesson (tested via plugin hook behavior)
// ---------------------------------------------------------------------------

describe("deriveLesson", () => {
  afterEach(() => {
    clearHindsight("test-session");
    setHindsightSession(null);
  });
  // We test deriveLesson indirectly by recording entries and checking the
  // lesson field. Since deriveLesson is internal, we exercise it through
  // the plugin's tool:after hook.
  it("produces file-not-found lesson", async () => {
    const registry = createPluginRegistry();
    const plugin = createHindsightPlugin();
    await plugin.setup?.(makeCtx(registry));

    setHindsightSession("test-session");
    await runHooks(registry, "tool:after", {
      tool: "read",
      input: "src/foo.ts",
      result: { _tag: "error", error: "ENOENT: no such file or directory" },
      ctx: {},
    });

    const entries = await getHindsight({ sessionId: "test-session" });
    expect(entries).toHaveLength(1);
    expect(entries[0].lesson).toContain("File not found");
    setHindsightSession(null);
  });

  it("produces permission-denied lesson", async () => {
    const registry = createPluginRegistry();
    const plugin = createHindsightPlugin();
    await plugin.setup?.(makeCtx(registry));

    setHindsightSession("test-session");
    await runHooks(registry, "tool:after", {
      tool: "bash",
      input: "rm -rf /",
      result: { _tag: "error", error: "Permission denied" },
      ctx: {},
    });

    const entries = await getHindsight({ sessionId: "test-session" });
    expect(entries).toHaveLength(1);
    expect(entries[0].lesson).toContain("Permission denied");
    setHindsightSession(null);
  });

  it("produces JSON parse error lesson", async () => {
    const registry = createPluginRegistry();
    const plugin = createHindsightPlugin();
    await plugin.setup?.(makeCtx(registry));

    setHindsightSession("test-session");
    await runHooks(registry, "tool:after", {
      tool: "eval",
      input: '{"key": "value"',
      result: { _tag: "error", error: "Invalid JSON: unexpected end of input" },
      ctx: {},
    });

    const entries = await getHindsight({ sessionId: "test-session" });
    expect(entries).toHaveLength(1);
    expect(entries[0].lesson).toContain("JSON parse error");
    setHindsightSession(null);
  });

  it("produces generic fallback lesson for unknown errors", async () => {
    const registry = createPluginRegistry();
    const plugin = createHindsightPlugin();
    await plugin.setup?.(makeCtx(registry));

    setHindsightSession("test-session");
    await runHooks(registry, "tool:after", {
      tool: "custom_tool",
      input: "args",
      result: { _tag: "error", error: "internal server error occurred" },
      ctx: {},
    });

    const entries = await getHindsight({ sessionId: "test-session" });
    expect(entries).toHaveLength(1);
    expect(entries[0].lesson).toContain("internal server error occurred");
    setHindsightSession(null);
  });
});

// ---------------------------------------------------------------------------
// message:before injection
// ---------------------------------------------------------------------------

describe("message:before injection", () => {
  afterEach(() => {
    clearHindsight("test-session");
    setHindsightSession(null);
  });

  it("injects hindsight as a system message when entries exist", async () => {
    const registry = createPluginRegistry();
    const plugin = createHindsightPlugin();
    await plugin.setup?.(makeCtx(registry));

    setHindsightSession("test-session");
    await recordHindsight("test-session", {
      action: "read(src/foo.ts)",
      outcome: "not found",
      lesson: "Check path before reading.",
    });

    const messages = [{ role: "user" as const, content: "hello" }];
    const result = await runHooks(registry, "message:before", { messages });
    const injected = result.messages as Array<{ role: string; content: string }>;

    expect(injected[0].role).toBe("system");
    expect(injected[0].content).toContain("Hindsight");
    expect(injected[0].content).toContain("Check path before reading");
    expect(injected).toHaveLength(2); // system + user
  });

  it("does not inject when there are no entries", async () => {
    const registry = createPluginRegistry();
    const plugin = createHindsightPlugin();
    await plugin.setup?.(makeCtx(registry));

    setHindsightSession("test-session");
    const messages = [{ role: "user" as const, content: "hello" }];
    const result = await runHooks(registry, "message:before", { messages });
    const injected = result.messages as Array<{ role: string; content: string }>;

    expect(injected).toHaveLength(1);
    expect(injected[0].role).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// setHindsightSession
// ---------------------------------------------------------------------------

describe("setHindsightSession", () => {
  afterEach(() => {
    clearHindsight("session-a");
    clearHindsight("session-b");
    setHindsightSession(null);
  });

  it("controls which session receives entries", async () => {
    setHindsightSession("session-a");
    await recordHindsight("session-a", {
      action: "read(a.ts)",
      outcome: "not found",
      lesson: "Lesson A",
    });

    setHindsightSession("session-b");
    await recordHindsight("session-b", {
      action: "read(b.ts)",
      outcome: "not found",
      lesson: "Lesson B",
    });

    const a = await getHindsight({ sessionId: "session-a" });
    const b = await getHindsight({ sessionId: "session-b" });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].lesson).toBe("Lesson A");
    expect(b[0].lesson).toBe("Lesson B");

    clearHindsight("session-a");
    clearHindsight("session-b");
  });
});
