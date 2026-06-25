// Tests for compaction context injector plugin.

import { describe, expect, it } from "vitest";

import {
  buildContextInjection,
  extractContext,
  injectCompactionContext,
} from "./compaction-context-injector";

// ---------------------------------------------------------------------------
// extractContext
// ---------------------------------------------------------------------------

describe("extractContext", () => {
  it("extracts modified files from tool call messages", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: "I'll write the new file at src/plugins/compaction-context-injector.ts",
      },
      {
        role: "tool" as const,
        content: '{"path": "src/plugins/index.ts", "content": "..."}',
      },
    ];
    const ctx = extractContext(messages);
    expect(ctx.modifiedFiles).toContain("src/plugins/compaction-context-injector.ts");
    expect(ctx.modifiedFiles).toContain("src/plugins/index.ts");
  });

  it("extracts decisions from assistant messages", () => {
    const messages = [
      {
        role: "assistant" as const,
        content:
          "I decided to use a hook-based approach for the compaction context. I'll use data + functions pattern.",
      },
    ];
    const ctx = extractContext(messages);
    expect(ctx.decisions.length).toBeGreaterThan(0);
  });

  it("extracts next steps from the last assistant message", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: "The implementation is done. Next step: add tests and verify the hook works correctly.",
      },
    ];
    const ctx = extractContext(messages);
    expect(ctx.nextSteps.length).toBeGreaterThan(0);
  });

  it("returns empty context for messages with no extractable content", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi there" },
    ];
    const ctx = extractContext(messages);
    expect(ctx.modifiedFiles).toEqual([]);
    expect(ctx.decisions).toEqual([]);
    expect(ctx.nextSteps).toEqual([]);
  });

  it("deduplicates file paths", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: "edit src/foo.ts and then edit src/foo.ts again",
      },
    ];
    const ctx = extractContext(messages);
    expect(ctx.modifiedFiles.filter((f) => f.includes("src/foo.ts")).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildContextInjection
// ---------------------------------------------------------------------------

describe("buildContextInjection", () => {
  it("includes all sections when present", () => {
    const ctx = {
      modifiedFiles: ["src/foo.ts", "src/bar.ts"],
      decisions: ["decided to use hooks"],
      nextSteps: ["add tests"],
    };
    const text = buildContextInjection(ctx);
    expect(text).toContain("Compaction Context");
    expect(text).toContain("Modified Files");
    expect(text).toContain("Key Decisions");
    expect(text).toContain("Next Steps");
    expect(text).toContain("`src/foo.ts`");
  });

  it("omits empty sections", () => {
    const ctx = {
      modifiedFiles: [],
      decisions: [],
      nextSteps: ["add tests"],
    };
    const text = buildContextInjection(ctx);
    expect(text).not.toContain("Modified Files");
    expect(text).not.toContain("Key Decisions");
    expect(text).toContain("Next Steps");
  });
});

// ---------------------------------------------------------------------------
// injectCompactionContext
// ---------------------------------------------------------------------------

describe("injectCompactionContext", () => {
  it("injects context when a compaction summary is present", () => {
    const messages = [
      {
        role: "system" as const,
        content: "[Compacted summary of earlier conversation]",
      },
      {
        role: "assistant" as const,
        content: "I decided to refactor. Next step: run tests.",
      },
    ];
    const result = injectCompactionContext(messages as unknown[]) as unknown[];
    expect(result.length).toBeGreaterThan(messages.length);
    const injected = result[result.length - 1] as { role: string; content: string };
    expect(injected.role).toBe("system");
    expect(injected.content).toContain("Compaction Context");
  });

  it("returns original messages when no compaction summary is present", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ];
    const result = injectCompactionContext(messages as unknown[]) as unknown[];
    expect(result).toBe(messages);
  });

  it("returns original messages when context is empty", () => {
    const messages = [
      {
        role: "system" as const,
        content: "[Compacted summary of earlier conversation]",
      },
      {
        role: "assistant" as const,
        content: "nothing interesting here",
      },
    ];
    const result = injectCompactionContext(messages as unknown[]) as unknown[];
    expect(result).toBe(messages);
  });
});
