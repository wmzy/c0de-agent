// Focused tests for the enhanced output truncator features:
//   - Tool-type strategy registry
//   - Auto-summary generation
//   - Truncation statistics
//   - Region-aware semantic truncation
//
// Run: bun test src/tools/output-truncator.enhanced.test.ts

import { describe, expect, it } from "vitest";
import {
  classifyLine,
  classifyLines,
  truncateSmart,
  truncateOutput,
  truncateOutputForTool,
  truncateToolResult,
  resolveToolStrategy,
  createDefaultToolRegistry,
  generateTruncationSummary,
  computeTruncationStats,
  emitTruncationLog,
  bashStrategy,
  grepStrategy,
  testStrategy,
  DEFAULT_TRUNCATOR_CONFIG,
} from "./output-truncator";
import type {
  TruncationStrategy,
  SmartStrategy,
  ToolStrategyRegistry,
  OutputTruncatorConfig,
  TruncationLogEntry,
} from "./output-truncator";
import type { ToolResult } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate N lines of noise + some important lines. */
function makeOutput(
  noiseCount: number,
  importantLines: { at: number; text: string }[],
): string {
  const lines: string[] = [];
  for (let i = 0; i < noiseCount; i++) {
    lines.push(`normal line ${i}: just noise data`);
  }
  for (const { at, text } of importantLines) {
    lines[at] = text;
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool-Type Strategy Registry
// ---------------------------------------------------------------------------

describe("createDefaultToolRegistry", () => {
  it("returns a registry with overrides", () => {
    const reg = createDefaultToolRegistry();
    expect(reg.overrides.length).toBeGreaterThan(0);
    expect(reg.defaultStrategy._tag).toBe("smart");
  });
});

describe("resolveToolStrategy", () => {
  const reg = createDefaultToolRegistry();

  it("resolves bash to a smart strategy", () => {
    const s = resolveToolStrategy("bash", reg);
    expect(s._tag).toBe("smart");
  });

  it("resolves grep to a smart strategy", () => {
    const s = resolveToolStrategy("grep", reg);
    expect(s._tag).toBe("smart");
  });

  it("resolves read to a smart strategy", () => {
    const s = resolveToolStrategy("read", reg);
    expect(s._tag).toBe("smart");
  });

  it("falls back to default for unknown tool", () => {
    const s = resolveToolStrategy("unknown_tool", reg);
    expect(s._tag).toBe("smart");
    expect(s).toBe(reg.defaultStrategy);
  });

  it("matches prefix patterns (ast_grep starts with ast_)", () => {
    const s = resolveToolStrategy("ast_grep", reg);
    expect(s._tag).toBe("smart");
  });

  it("resolves edit tool", () => {
    const s = resolveToolStrategy("edit", reg);
    expect(s._tag).toBe("smart");
  });

  it("resolves debug tool", () => {
    const s = resolveToolStrategy("debug_continue", reg);
    expect(s._tag).toBe("smart");
  });
});

// ---------------------------------------------------------------------------
// truncateOutputForTool — full integration
// ---------------------------------------------------------------------------

describe("truncateOutputForTool", () => {
  it("uses tool registry to resolve strategy and truncates", () => {
    const config: OutputTruncatorConfig = {
      strategy: DEFAULT_TRUNCATOR_CONFIG.strategy,
      toolRegistry: createDefaultToolRegistry(),
      collectStats: true,
      autoSummary: true,
    };
    const output = makeOutput(600, [
      { at: 100, text: "Error: ENOENT: no such file or directory" },
      { at: 300, text: "warning: deprecated API" },
    ]);
    const result = truncateOutputForTool(output, "bash", config);
    expect(result.truncated).toBe(true);
    expect(result.stats).toBeDefined();
    expect(result.summary).toBeDefined();
    expect(result.summary!.headline).toContain("error");
    expect(result.summary!.errorsPreserved.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// truncateOutput with config — auto-summary & stats
// ---------------------------------------------------------------------------

describe("truncateOutput with config", () => {
  it("generates auto-summary when enabled", () => {
    const output = makeOutput(200, [
      { at: 50, text: "Error: connection refused" },
      { at: 100, text: "warning: retrying" },
    ]);
    const strategy: SmartStrategy = {
      _tag: "smart",
      maxLines: 50,
      maxChars: 5000,
      headLines: 5,
      tailLines: 5,
      contextRadius: 2,
    };
    const config: OutputTruncatorConfig = {
      strategy,
      autoSummary: true,
    };
    const result = truncateOutput(output, strategy, config);
    expect(result.truncated).toBe(true);
    expect(result.summary).toBeDefined();
    expect(result.summary!.errorsPreserved.length).toBeGreaterThan(0);
    expect(result.summary!.indicatesSuccess).toBe(false);
  });

  it("generates stats when collectStats enabled", () => {
    const output = makeOutput(200, [
      { at: 50, text: "Error: something broke" },
    ]);
    const strategy: SmartStrategy = {
      _tag: "smart",
      maxLines: 50,
      maxChars: 5000,
      headLines: 5,
      tailLines: 5,
      contextRadius: 2,
    };
    const config: OutputTruncatorConfig = {
      strategy,
      collectStats: true,
    };
    const result = truncateOutput(output, strategy, config);
    expect(result.truncated).toBe(true);
    expect(result.stats).toBeDefined();
    expect(result.stats!.linesDropped).toBeGreaterThan(0);
    expect(result.stats!.retentionPercent).toBeLessThan(100);
    expect(result.stats!.classificationBreakdown.error).toBeGreaterThan(0);
  });

  it("calls onTruncationLog when truncation occurs", () => {
    const logEntries: TruncationLogEntry[] = [];
    const output = makeOutput(100, [
      { at: 10, text: "error: test" },
    ]);
    const strategy: SmartStrategy = {
      _tag: "smart",
      maxLines: 20,
      maxChars: 2000,
      headLines: 3,
      tailLines: 3,
      contextRadius: 1,
    };
    const config: OutputTruncatorConfig = {
      strategy,
      onTruncationLog: (entry) => logEntries.push(entry),
    };
    truncateOutput(output, strategy, config);
    expect(logEntries.length).toBe(1);
    expect(logEntries[0].truncated).toBe(true);
    expect(logEntries[0].strategy).toBe("smart");
    expect(logEntries[0].timestamp).toBeTruthy();
  });

  it("does not call onTruncationLog when no truncation needed", () => {
    const logEntries: TruncationLogEntry[] = [];
    const output = "short output";
    const strategy: SmartStrategy = {
      _tag: "smart",
      maxLines: 1000,
      maxChars: 100_000,
      headLines: 10,
      tailLines: 10,
      contextRadius: 2,
    };
    const config: OutputTruncatorConfig = {
      strategy,
      onTruncationLog: (entry) => logEntries.push(entry),
    };
    truncateOutput(output, strategy, config);
    expect(logEntries.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Auto-summary generation
// ---------------------------------------------------------------------------

describe("generateTruncationSummary", () => {
  it("reports errors when error lines are retained", () => {
    const lines = classifyLines("line1\nError: fatal crash\nline3");
    const retained = new Set([0, 1, 2]);
    const summary = generateTruncationSummary(lines, retained, "smart");
    expect(summary.headline).toContain("error");
    expect(summary.errorsPreserved.length).toBeGreaterThan(0);
    expect(summary.indicatesSuccess).toBe(false);
  });

  it("reports success when no errors", () => {
    const lines = classifyLines("hello world\nnormal line\ngoodbye");
    const retained = new Set([0, 1, 2]);
    const summary = generateTruncationSummary(lines, retained, "semantic");
    expect(summary.indicatesSuccess).toBe(true);
    expect(summary.headline).toContain("no critical content lost");
  });

  it("reports warnings", () => {
    const lines = classifyLines("normal\nwarning: deprecated\nnormal2");
    const retained = new Set([0, 1, 2]);
    const summary = generateTruncationSummary(lines, retained, "line");
    expect(summary.warningsPreserved.length).toBeGreaterThan(0);
    expect(summary.headline).toContain("warning");
  });
});

// ---------------------------------------------------------------------------
// Truncation statistics
// ---------------------------------------------------------------------------

describe("computeTruncationStats", () => {
  it("computes correct stats for a truncation", () => {
    const lines = classifyLines(
      "normal\nnormal\nError: bad\nnormal\nwarning: careful\nnormal",
    );
    const retained = new Set([0, 2, 4]); // keep normal, error, warning
    const stats = computeTruncationStats(lines, retained, 1000, 500, 1.5);
    expect(stats.linesDropped).toBe(3);
    expect(stats.charsDropped).toBe(500);
    expect(stats.retentionPercent).toBe(50);
    expect(stats.noiseLinesRemoved).toBe(3);
    expect(stats.elapsedMs).toBe(1.5);
    expect(stats.classificationBreakdown.error).toBe(1);
    expect(stats.classificationBreakdown.warning).toBe(1);
    expect(stats.classificationBreakdown.normal).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// emitTruncationLog
// ---------------------------------------------------------------------------

describe("emitTruncationLog", () => {
  it("calls callback when provided", () => {
    let received: TruncationLogEntry | null = null;
    const entry: TruncationLogEntry = {
      timestamp: new Date().toISOString(),
      toolName: "bash",
      strategy: "smart",
      truncated: true,
    };
    emitTruncationLog(entry, (e) => { received = e; });
    expect(received).toBe(entry);
  });

  it("does not throw when no callback", () => {
    const entry: TruncationLogEntry = {
      timestamp: new Date().toISOString(),
      strategy: "char",
      truncated: false,
    };
    expect(() => emitTruncationLog(entry)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Enhanced semantic truncation — region preservation
// ---------------------------------------------------------------------------

describe("enhanced smart truncation", () => {
  it("preserves contiguous error blocks", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push(`normal ${i}`);
    for (let i = 0; i < 10; i++) lines.push(`Error: catastrophe ${i}`);
    for (let i = 0; i < 180; i++) lines.push(`noise ${i}`);
    const output = lines.join("\n");

    const strategy: SmartStrategy = {
      _tag: "smart",
      maxLines: 40,
      maxChars: 10_000,
      headLines: 5,
      tailLines: 5,
      contextRadius: 2,
    };
    const result = truncateSmart(output, strategy);
    expect(result.truncated).toBe(true);
    expect(result.preservedRegions).toContain("error");
  });

  it("respects priority patterns", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push(`line ${i}`);
    lines[50] = "CUSTOM_PRIORITY: very important data";
    const output = lines.join("\n");

    const strategy: SmartStrategy = {
      _tag: "smart",
      maxLines: 20,
      maxChars: 5000,
      headLines: 3,
      tailLines: 3,
      contextRadius: 2,
      priorityPatterns: [/CUSTOM_PRIORITY/],
    };
    const result = truncateSmart(output, strategy);
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("CUSTOM_PRIORITY");
  });

  it("applies noise patterns to suppress noise", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      if (i % 5 === 0) lines.push("Error: problem");
      else lines.push(`noise ${i}`);
    }
    const output = lines.join("\n");

    const strategy: SmartStrategy = {
      _tag: "smart",
      maxLines: 20,
      maxChars: 5000,
      headLines: 3,
      tailLines: 3,
      contextRadius: 1,
      noisePatterns: [/^noise/],
    };
    const result = truncateSmart(output, strategy);
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("Error");
  });
});

// ---------------------------------------------------------------------------
// Tool-type specific strategies produce different results
// ---------------------------------------------------------------------------

describe("tool-type strategy differentiation", () => {
  it("bashStrategy produces different config than grepStrategy", () => {
    const bash = bashStrategy();
    const grep = grepStrategy();
    expect(bash.headLines).toBeLessThan(grep.headLines);
    expect(bash.tailLines).toBeGreaterThan(grep.tailLines);
  });

  it("testStrategy has progress dot noise pattern", () => {
    const test = testStrategy();
    expect(test.noisePatterns).toBeDefined();
    expect(test.noisePatterns!.length).toBeGreaterThan(0);
  });

  it("tool-specific truncation with bash keeps errors", () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push("building...");
    lines[100] = "Error: build failed";
    lines[150] = "warning: unused variable";
    const output = lines.join("\n");

    const bashStrat = bashStrategy(50, 5000);
    const result = truncateSmart(output, bashStrat);
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("Error: build failed");
  });

  it("tool-specific truncation with grep keeps file:line format", () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) lines.push(`result ${i}`);
    lines[100] = "src/index.ts:42: const x = 1;";
    lines[200] = "src/utils.ts:15: function foo() {}";
    const output = lines.join("\n");

    const grepStrat = grepStrategy(20, 5000);
    const result = truncateSmart(output, grepStrat);
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("src/index.ts:42:");
  });
});

// ---------------------------------------------------------------------------
// truncateToolResult integration
// ---------------------------------------------------------------------------

describe("truncateToolResult with config", () => {
  it("passes through error results unchanged", () => {
    const result: ToolResult = { _tag: "error", error: "bad" };
    const strategy = bashStrategy();
    const config: OutputTruncatorConfig = {
      strategy,
      autoSummary: true,
    };
    const out = truncateToolResult(result, strategy, config);
    expect(out).toBe(result);
  });

  it("truncates success results with summary", () => {
    const longOutput = makeOutput(200, [
      { at: 50, text: "Error: ENOENT" },
    ]);
    const result: ToolResult = { _tag: "success", output: longOutput };
    const strategy: SmartStrategy = {
      _tag: "smart",
      maxLines: 30,
      maxChars: 3000,
      headLines: 3,
      tailLines: 3,
      contextRadius: 1,
    };
    const config: OutputTruncatorConfig = {
      strategy,
      autoSummary: true,
    };
    const out = truncateToolResult(result, strategy, config, "bash");
    expect(out._tag).toBe("truncated");
  });
});
