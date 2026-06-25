// Tests for output-analyzer.ts

import { describe, expect, it } from "vitest";
import {
  analyzeToolOutput,
  detectOutputFormat,
  detectErrors,
  extractKeyInfo,
  generateSummary,
  hasErrors,
  hasWarnings,
  getMostSevereError,
  formatAnalysisResult,
} from "./output-analyzer";

// ---------------------------------------------------------------------------
// detectOutputFormat tests
// ---------------------------------------------------------------------------

describe("detectOutputFormat", () => {
  it("detects empty output as text", () => {
    const result = detectOutputFormat("");
    expect(result).toEqual({ _tag: "text" });
  });

  it("detects valid JSON object", () => {
    const result = detectOutputFormat('{"key": "value"}');
    expect(result).toEqual({ _tag: "json", valid: true, depth: 1 });
  });

  it("detects valid JSON array", () => {
    const result = detectOutputFormat('[1, 2, 3]');
    expect(result).toEqual({ _tag: "json", valid: true, depth: 1 });
  });

  it("detects nested JSON", () => {
    const result = detectOutputFormat('{"a": {"b": {"c": 1}}}');
    expect(result).toEqual({ _tag: "json", valid: true, depth: 3 });
  });

  it("detects invalid JSON", () => {
    const result = detectOutputFormat('{"key": "value"');
    expect(result).toEqual({ _tag: "json", valid: false });
  });

  it("detects JSONL format", () => {
    const result = detectOutputFormat('{"a": 1}\n{"b": 2}\n{"c": 3}');
    expect(result).toEqual({ _tag: "log", format: "jsonl" });
  });

  it("detects stack trace (JS)", () => {
    const result = detectOutputFormat(
      "Error: something\n    at foo (bar.js:10:5)\n    at baz (qux.js:20:10)"
    );
    expect(result).toEqual({ _tag: "stack-trace" });
  });

  it("detects stack trace (Python)", () => {
    const result = detectOutputFormat(
      "Traceback (most recent call last):\n  File \"foo.py\", line 10\n  File \"bar.py\", line 20"
    );
    expect(result).toEqual({ _tag: "stack-trace" });
  });

  it("detects diff format", () => {
    const result = detectOutputFormat(
      "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@"
    );
    expect(result).toEqual({ _tag: "diff" });
  });

  it("detects table format", () => {
    const result = detectOutputFormat("| Header1 | Header2 |\n|---------|---------|\n| Value1  | Value2  |");
    expect(result).toEqual({ _tag: "table" });
  });

  it("detects structured log format", () => {
    const result = detectOutputFormat(
      "[2024-01-01 12:00:00] INFO: Started\n[2024-01-01 12:00:01] INFO: Processing\n[2024-01-01 12:00:02] INFO: Done"
    );
    expect(result).toEqual({ _tag: "log", format: "structured" });
  });

  it("defaults to text for plain output", () => {
    const result = detectOutputFormat("Hello, world!");
    expect(result).toEqual({ _tag: "text" });
  });
});

// ---------------------------------------------------------------------------
// detectErrors tests
// ---------------------------------------------------------------------------

describe("detectErrors", () => {
  it("detects fatal errors", () => {
    const errors = detectErrors("FATAL: something went wrong");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("fatal");
  });

  it("detects segmentation fault", () => {
    const errors = detectErrors("segfault at 0x0");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("fatal");
  });

  it("detects panic", () => {
    const errors = detectErrors("panic: runtime error");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("fatal");
  });

  it("detects standard errors", () => {
    const errors = detectErrors("Error: something failed");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
  });

  it("detects JavaScript errors", () => {
    const errors = detectErrors("TypeError: Cannot read property 'x' of undefined");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
    expect(errors[0].message).toContain("TypeError");
  });

  it("detects POSIX error codes", () => {
    const errors = detectErrors("ENOENT: no such file or directory");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
    expect(errors[0].message).toContain("ENOENT");
  });

  it("detects exit codes", () => {
    const errors = detectErrors("Exit code 1");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
    expect(errors[0].message).toContain("Exit code 1");
  });

  it("detects command not found", () => {
    const errors = detectErrors("bash: npm: command not found");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
  });

  it("detects warnings", () => {
    const errors = detectErrors("Warning: deprecated function");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("warning");
  });

  it("detects multiple errors on different lines", () => {
    const errors = detectErrors("Error: first\nWarning: second\nFatal: third");
    expect(errors).toHaveLength(3);
  });

  it("returns empty array for clean output", () => {
    const errors = detectErrors("All good, no issues here.");
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractKeyInfo tests
// ---------------------------------------------------------------------------

describe("extractKeyInfo", () => {
  it("extracts error messages", () => {
    const info = extractKeyInfo("Error: something failed\nAll good");
    expect(info.errors).toContain("Error: something failed");
  });

  it("extracts warning messages", () => {
    const info = extractKeyInfo("Warning: deprecated\nAll good");
    expect(info.warnings).toContain("Warning: deprecated");
  });

  it("extracts suggestions", () => {
    const info = extractKeyInfo("Try running npm install");
    expect(info.suggestions).toHaveLength(1);
    expect(info.suggestions[0].text).toContain("Try running npm install");
  });

  it("extracts file paths", () => {
    const info = extractKeyInfo("Found in /home/user/file.txt and src/main.ts");
    expect(info.paths.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts exit codes", () => {
    const info = extractKeyInfo("Exit code 1\nProcess exited with code 2");
    expect(info.exitCodes).toContain(1);
    expect(info.exitCodes).toContain(2);
  });

  it("extracts URLs as paths", () => {
    const info = extractKeyInfo("See https://example.com for more info");
    expect(info.paths.some((p) => p.includes("https://example.com"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generateSummary tests
// ---------------------------------------------------------------------------

describe("generateSummary", () => {
  it("generates success summary for clean output", () => {
    const summary = generateSummary("All good", [], {
      errors: [],
      warnings: [],
      suggestions: [],
      paths: [],
      exitCodes: [],
    });
    expect(summary.isSuccess).toBe(true);
    expect(summary.hasErrors).toBe(false);
    expect(summary.hasWarnings).toBe(false);
  });

  it("generates error summary for output with errors", () => {
    const errors = [{
      pattern: "test",
      severity: "error" as const,
      match: "Error",
      line: 1,
      message: "Error: something failed",
    }];
    const summary = generateSummary("Error: something failed", errors, {
      errors: ["Error: something failed"],
      warnings: [],
      suggestions: [],
      paths: [],
      exitCodes: [],
    });
    expect(summary.isSuccess).toBe(false);
    expect(summary.hasErrors).toBe(true);
    expect(summary.headline).toContain("Errors detected");
  });

  it("generates warning summary for output with warnings", () => {
    const errors = [{
      pattern: "test",
      severity: "warning" as const,
      match: "Warning",
      line: 1,
      message: "Warning: deprecated",
    }];
    const summary = generateSummary("Warning: deprecated", errors, {
      errors: [],
      warnings: ["Warning: deprecated"],
      suggestions: [],
      paths: [],
      exitCodes: [],
    });
    expect(summary.hasWarnings).toBe(true);
    expect(summary.headline).toContain("Warnings detected");
  });
});

// ---------------------------------------------------------------------------
// analyzeToolOutput tests (integration)
// ---------------------------------------------------------------------------

describe("analyzeToolOutput", () => {
  it("analyzes error output", () => {
    const result = analyzeToolOutput("Error: Cannot find module './missing'\n    at Function.Module._resolveFilename");
    expect(result.format._tag).toBe("stack-trace");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.summary.hasErrors).toBe(true);
  });

  it("analyzes JSON output", () => {
    const result = analyzeToolOutput('{"status": "ok", "data": [1, 2, 3]}');
    expect(result.format._tag).toBe("json");
    expect((result.format as { _tag: "json"; valid: boolean }).valid).toBe(true);
    expect(result.summary.isSuccess).toBe(true);
  });

  it("analyzes log output", () => {
    const result = analyzeToolOutput(
      "[2024-01-01 12:00:00] INFO: Started\n[2024-01-01 12:00:01] ERROR: Failed to connect\n[2024-01-01 12:00:02] INFO: Retrying"
    );
    expect(result.format._tag).toBe("log");
    expect(result.summary.hasErrors).toBe(true);
  });

  it("analyzes clean output", () => {
    const result = analyzeToolOutput("Build successful. 5 files processed.");
    expect(result.summary.isSuccess).toBe(true);
    expect(result.summary.hasErrors).toBe(false);
  });

  it("includes tool name in result (no effect on analysis)", () => {
    const result = analyzeToolOutput("Error: test", "bash");
    expect(result.summary.hasErrors).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Convenience helpers tests
// ---------------------------------------------------------------------------

describe("convenience helpers", () => {
  it("hasErrors returns true for error output", () => {
    expect(hasErrors("Error: something failed")).toBe(true);
  });

  it("hasErrors returns false for clean output", () => {
    expect(hasErrors("All good")).toBe(false);
  });

  it("hasWarnings returns true for warning output", () => {
    expect(hasWarnings("Warning: deprecated")).toBe(true);
  });

  it("hasWarnings returns false for clean output", () => {
    expect(hasWarnings("All good")).toBe(false);
  });

  it("getMostSevereError returns fatal over error", () => {
    const error = getMostSevereError("Error: first\nFATAL: second");
    expect(error).not.toBeNull();
    expect(error!.severity).toBe("fatal");
  });

  it("getMostSevereError returns null for clean output", () => {
    const error = getMostSevereError("All good");
    expect(error).toBeNull();
  });

  it("formatAnalysisResult produces readable output", () => {
    const result = analyzeToolOutput("Error: something failed");
    const formatted = formatAnalysisResult(result);
    expect(formatted).toContain("Errors detected");
    expect(formatted).toContain("Error: something failed");
  });
});
