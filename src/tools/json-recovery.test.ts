// Tests for JSON error recovery (json-recovery.ts)
//
// Covers:
//   - detectJsonErrors: valid JSON, trailing commas, unquoted keys, etc.
//   - tryFixJson: single-fixer recovery, sequential pipeline, compound errors
//   - recoverToolInput: high-level API
//   - Individual fixers: markdown fences, comments, single quotes, etc.
//   - formatRecoverySummary: human-readable output
//   - Edge cases: empty input, deeply nested structures, real-world LLM output

import { describe, expect, it } from "vitest";
import {
  detectJsonErrors,
  tryFixJson,
  recoverToolInput,
  recoverJsonOrThrow,
  formatRecoverySummary,
  DEFAULT_FIXERS,
} from "./json-recovery";
import type { JsonRecoveryResult } from "./json-recovery";

// ---------------------------------------------------------------------------
// detectJsonErrors
// ---------------------------------------------------------------------------

describe("detectJsonErrors", () => {
  it("returns json_ok for valid JSON", () => {
    const result = detectJsonErrors('{"a": 1}');
    expect(result._tag).toBe("json_ok");
    if (result._tag === "json_ok") {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  it("detects trailing commas", () => {
    const result = detectJsonErrors('{"a": 1, "b": 2,}');
    expect(result._tag).toBe("json_error");
    if (result._tag === "json_error") {
      expect(result.kind).toBe("trailing_comma");
    }
  });

  it("detects markdown fences", () => {
    const result = detectJsonErrors('```json\n{"a": 1}\n```');
    expect(result._tag).toBe("json_error");
    if (result._tag === "json_error") {
      expect(result.kind).toBe("markdown_fence");
    }
  });

  it("detects line comments", () => {
    const result = detectJsonErrors('{\n  // comment\n  "a": 1\n}');
    expect(result._tag).toBe("json_error");
    if (result._tag === "json_error") {
      expect(result.kind).toBe("line_comment");
    }
  });

  it("detects block comments", () => {
    const result = detectJsonErrors('{"a": /* value */ 1}');
    expect(result._tag).toBe("json_error");
    if (result._tag === "json_error") {
      expect(result.kind).toBe("block_comment");
    }
  });

  it("detects JS literals", () => {
    const result = detectJsonErrors('{"a": undefined}');
    expect(result._tag).toBe("json_error");
    if (result._tag === "json_error") {
      expect(result.kind).toBe("js_literal");
    }
  });

  it("detects missing brackets", () => {
    const result = detectJsonErrors('{"a": {"b": 1}');
    expect(result._tag).toBe("json_error");
    if (result._tag === "json_error") {
      expect(result.kind).toBe("missing_bracket");
    }
  });

  it("handles empty string", () => {
    const result = detectJsonErrors("");
    expect(result._tag).toBe("json_error");
  });

  it("preserves position when available", () => {
    const result = detectJsonErrors('{"a": 1, "b":}');
    expect(result._tag).toBe("json_error");
    if (result._tag === "json_error") {
      // position may or may not be extracted depending on engine
      expect(typeof result.position === "number" || result.position === undefined).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// tryFixJson — trailing commas
// ---------------------------------------------------------------------------

describe("tryFixJson — trailing commas", () => {
  it("removes trailing comma before closing brace", () => {
    const result = tryFixJson('{"a": 1,}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: 1 });
      expect(result.fixes).toContain("remove_trailing_commas");
    }
  });

  it("removes trailing comma before closing bracket", () => {
    const result = tryFixJson("[1, 2, 3,]");
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual([1, 2, 3]);
    }
  });

  it("removes multiple trailing commas", () => {
    const result = tryFixJson('{"a": 1, "b": 2,}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: 1, b: 2 });
    }
  });
});

// ---------------------------------------------------------------------------
// tryFixJson — markdown fences
// ---------------------------------------------------------------------------

describe("tryFixJson — markdown fences", () => {
  it("strips ```json fences", () => {
    const result = tryFixJson('```json\n{"a": 1}\n```');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  it("strips ``` fences without language tag", () => {
    const result = tryFixJson('```\n{"a": 1}\n```');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  it("strips fences with trailing text", () => {
    const result = tryFixJson('```json\n{"a": 1}\n```\nSome explanation here');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: 1 });
    }
  });
});

// ---------------------------------------------------------------------------
// tryFixJson — comments
// ---------------------------------------------------------------------------

describe("tryFixJson — comments", () => {
  it("removes line comments", () => {
    const result = tryFixJson('{\n  // this is a comment\n  "a": 1\n}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  it("removes block comments", () => {
    const result = tryFixJson('{"a": /* value */ 1}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  it("does not remove // inside string values", () => {
    const result = tryFixJson('{"url": "https://example.com"}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ url: "https://example.com" });
    }
  });
});

// ---------------------------------------------------------------------------
// tryFixJson — single quotes
// ---------------------------------------------------------------------------

describe("tryFixJson — single quotes", () => {
  it("replaces single-quoted keys and values", () => {
    const result = tryFixJson("{'name': 'test'}");
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ name: "test" });
    }
  });

  it("handles single quotes with double quotes inside values", () => {
    const result = tryFixJson("{'msg': 'say \"hello\"'}");
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ msg: 'say "hello"' });
    }
  });
});

// ---------------------------------------------------------------------------
// tryFixJson — unquoted keys
// ---------------------------------------------------------------------------

describe("tryFixJson — unquoted keys", () => {
  it("quotes unquoted keys", () => {
    const result = tryFixJson('{name: "test", age: 25}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ name: "test", age: 25 });
    }
  });

  it("quotes unquoted keys with numeric values", () => {
    const result = tryFixJson('{count: 42}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ count: 42 });
    }
  });
});

// ---------------------------------------------------------------------------
// tryFixJson — JS literals
// ---------------------------------------------------------------------------

describe("tryFixJson — JS literals", () => {
  it("replaces undefined with null", () => {
    const result = tryFixJson('{"a": undefined}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: null });
    }
  });

  it("replaces NaN with null", () => {
    const result = tryFixJson('{"a": NaN}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: null });
    }
  });

  it("replaces Infinity with null", () => {
    const result = tryFixJson('{"a": Infinity}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: null });
    }
  });

  it("does not replace JS literals inside strings", () => {
    const result = tryFixJson('{"a": "undefined"}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: "undefined" });
    }
  });
});

// ---------------------------------------------------------------------------
// tryFixJson — missing brackets
// ---------------------------------------------------------------------------

describe("tryFixJson — missing brackets", () => {
  it("adds missing closing brace", () => {
    const result = tryFixJson('{"a": {"b": 1}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: { b: 1 } });
    }
  });

  it("adds missing closing bracket", () => {
    const result = tryFixJson('{"a": [1, 2}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: [1, 2] });
    }
  });
});

// ---------------------------------------------------------------------------
// tryFixJson — compound errors
// ---------------------------------------------------------------------------

describe("tryFixJson — compound errors", () => {
  it("fixes markdown fence + trailing comma", () => {
    const result = tryFixJson('```json\n{"a": 1,}\n```');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  it("fixes comments + trailing comma", () => {
    const result = tryFixJson('{\n  // config\n  "a": 1,\n  "b": 2,\n}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: 1, b: 2 });
    }
  });

  it("fixes surrounding text + trailing comma", () => {
    const result = tryFixJson('Here is the JSON:\n{"a": 1, "b": 2,}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: 1, b: 2 });
    }
  });

  it("handles real-world LLM output: fences + trailing comma + comments", () => {
    const input = `I'll use this configuration:

\`\`\`json
{
  // Main configuration
  "tool": "bash",
  "command": "echo hello",
  "timeout": 30000,
}
\`\`\``;
    const result = tryFixJson(input);
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({
        tool: "bash",
        command: "echo hello",
        timeout: 30000,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// tryFixJson — already valid
// ---------------------------------------------------------------------------

describe("tryFixJson — already valid", () => {
  it("returns recovered with empty fixes for valid JSON", () => {
    const result = tryFixJson('{"a": 1, "b": [2, 3]}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.fixes).toEqual([]);
      expect(result.value).toEqual({ a: 1, b: [2, 3] });
    }
  });

  it("handles nested objects", () => {
    const input = '{"a": {"b": {"c": [1, 2, 3]}}}';
    const result = tryFixJson(input);
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: { b: { c: [1, 2, 3] } } });
    }
  });
});

// ---------------------------------------------------------------------------
// tryFixJson — unrecoverable
// ---------------------------------------------------------------------------

describe("tryFixJson — unrecoverable", () => {
  it("returns unrecoverable for garbage input", () => {
    const result = tryFixJson("not json at all {{{{");
    expect(result._tag).toBe("unrecoverable");
    if (result._tag === "unrecoverable") {
      expect(result.attemptedFixes.length).toBeGreaterThan(0);
      expect(result.original._tag).toBe("json_error");
    }
  });
});

// ---------------------------------------------------------------------------
// recoverToolInput
// ---------------------------------------------------------------------------

describe("recoverToolInput", () => {
  it("recovers trailing comma", () => {
    const result = recoverToolInput('{"command": "ls",}');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ command: "ls" });
    }
  });

  it("recovers markdown fences", () => {
    const result = recoverToolInput('```json\n{"command": "ls"}\n```');
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ command: "ls" });
    }
  });

  it("returns empty object for empty input", () => {
    const result = recoverToolInput("");
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({});
    }
  });

  it("returns empty object for whitespace-only input", () => {
    const result = recoverToolInput("   \n  \t  ");
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({});
    }
  });

  it("handles deeply nested structures", () => {
    const input = '{"a":{"b":{"c":{"d":{"e":1}}}}}';
    const result = recoverToolInput(input);
    expect(result._tag).toBe("recovered");
    if (result._tag === "recovered") {
      expect(result.value).toEqual({ a: { b: { c: { d: { e: 1 } } } } });
    }
  });
});

// ---------------------------------------------------------------------------
// recoverJsonOrThrow
// ---------------------------------------------------------------------------

describe("recoverJsonOrThrow", () => {
  it("returns parsed value for recoverable input", () => {
    const value = recoverJsonOrThrow('{"a": 1,}');
    expect(value).toEqual({ a: 1 });
  });

  it("throws for unrecoverable input", () => {
    expect(() => recoverJsonOrThrow("garbage {{{")).toThrow("JSON recovery failed");
  });
});

// ---------------------------------------------------------------------------
// formatRecoverySummary
// ---------------------------------------------------------------------------

describe("formatRecoverySummary", () => {
  it("reports already valid", () => {
    const result = tryFixJson('{"a": 1}');
    expect(formatRecoverySummary(result)).toBe("JSON was already valid.");
  });

  it("reports fixes applied", () => {
    const result = tryFixJson('{"a": 1,}');
    const summary = formatRecoverySummary(result);
    expect(summary).toContain("Recovered");
    expect(summary).toContain("remove_trailing_commas");
  });

  it("reports unrecoverable errors", () => {
    const result = tryFixJson("garbage");
    const summary = formatRecoverySummary(result);
    expect(summary).toContain("Unrecoverable");
  });
});

// ---------------------------------------------------------------------------
// Individual fixer edge cases
// ---------------------------------------------------------------------------

describe("individual fixers — edge cases", () => {
  it("fixer: removeTrailingCommas preserves non-trailing commas", () => {
    const fixer = DEFAULT_FIXERS.find((f) => f.name === "remove_trailing_commas")!;
    const result = fixer.apply('{"a": 1, "b": 2}');
    expect(result).toBe('{"a": 1, "b": 2}');
  });

  it("fixer: stripSurroundingText handles text before and after JSON", () => {
    const fixer = DEFAULT_FIXERS.find((f) => f.name === "strip_surrounding_text")!;
    const result = fixer.apply('Here is the config: {"a": 1} and more text');
    // The fixer extracts just the JSON, stripping surrounding prose
    expect(result).toBe('{"a": 1}');
  });

  it("fixer: quoteUnquotedKeys handles nested objects", () => {
    const fixer = DEFAULT_FIXERS.find((f) => f.name === "quote_unquoted_keys")!;
    const result = fixer.apply('{outer: {inner: 1}}');
    expect(result).toBe('{"outer": {"inner": 1}}');
  });

  it("fixer: replaceJsLiterals handles multiple literals", () => {
    const fixer = DEFAULT_FIXERS.find((f) => f.name === "replace_js_literals")!;
    const result = fixer.apply('{"a": undefined, "b": NaN}');
    expect(result).toBe('{"a": null, "b": null}');
  });

  it("fixer: addMissingBrackets handles nested missing brackets", () => {
    const fixer = DEFAULT_FIXERS.find((f) => f.name === "add_missing_brackets")!;
    const result = fixer.apply('{"a": {"b": [1, 2}');
    expect(result).toBe('{"a": {"b": [1, 2]}}');
  });

  it("fixer: removeComments preserves strings with slashes", () => {
    const fixer = DEFAULT_FIXERS.find((f) => f.name === "remove_comments")!;
    const result = fixer.apply('{"path": "C:\\\\Users\\\\test"}');
    expect(result).toBe('{"path": "C:\\\\Users\\\\test"}');
  });

  it("fixer: replaceSingleQuotes preserves apostrophes in values", () => {
    const fixer = DEFAULT_FIXERS.find((f) => f.name === "replace_single_quotes")!;
    const result = fixer.apply("{'msg': \"don't\"}");
    expect(result).toBe('{"msg": "don\'t"}');
  });
});
