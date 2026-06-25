// Tool-pair validator tests

import { describe, it, expect } from "vitest";
import {
  createPairValidatorState,
  validateToolCall,
  validateToolCalls,
  formatViolations,
  hasCriticalViolation,
} from "./tool-pair-validator";

describe("tool-pair-validator", () => {
  describe("edit-before-read rule", () => {
    it("should warn when editing a file without reading it first", () => {
      const state = createPairValidatorState();
      const violations = validateToolCall(
        state,
        "edit",
        JSON.stringify({ path: "src/file.ts", old_text: "a", new_text: "b" }),
      );
      expect(violations.length).toBe(1);
      expect(violations[0].rule).toBe("edit-before-read");
      expect(violations[0].severity).toBe("warning");
    });

    it("should not warn when editing a file after reading it", () => {
      const state = createPairValidatorState();
      validateToolCall(state, "read", JSON.stringify({ path: "src/file.ts" }));
      const violations = validateToolCall(
        state,
        "edit",
        JSON.stringify({ path: "src/file.ts", old_text: "a", new_text: "b" }),
      );
      expect(violations.filter((v) => v.rule === "edit-before-read").length).toBe(0);
    });

    it("should not warn when writing to a new file", () => {
      const state = createPairValidatorState();
      const violations = validateToolCall(
        state,
        "write",
        JSON.stringify({ path: "src/new-file.ts", content: "console.log('hello')" }),
      );
      expect(violations.filter((v) => v.rule === "edit-before-read").length).toBe(0);
    });

    it("should warn when writing to an existing file without reading", () => {
      const state = createPairValidatorState();
      validateToolCall(state, "read", JSON.stringify({ path: "src/existing.ts" }));
      const violations = validateToolCall(
        state,
        "write",
        JSON.stringify({ path: "src/existing.ts", content: "new content" }),
      );
      expect(violations.filter((v) => v.rule === "edit-before-read").length).toBe(1);
    });
  });

  describe("write-after-edit rule", () => {
    it("should error when writing immediately after editing the same file", () => {
      const state = createPairValidatorState();
      validateToolCall(state, "read", JSON.stringify({ path: "src/file.ts" }));
      validateToolCall(
        state,
        "edit",
        JSON.stringify({ path: "src/file.ts", old_text: "a", new_text: "b" }),
      );
      const violations = validateToolCall(
        state,
        "write",
        JSON.stringify({ path: "src/file.ts", content: "overwritten" }),
      );
      expect(violations.length).toBe(1);
      expect(violations[0].rule).toBe("write-after-edit");
      expect(violations[0].severity).toBe("error");
    });

    it("should not error when reading between edit and write", () => {
      const state = createPairValidatorState();
      validateToolCall(state, "read", JSON.stringify({ path: "src/file.ts" }));
      validateToolCall(
        state,
        "edit",
        JSON.stringify({ path: "src/file.ts", old_text: "a", new_text: "b" }),
      );
      validateToolCall(state, "read", JSON.stringify({ path: "src/file.ts" }));
      const violations = validateToolCall(
        state,
        "write",
        JSON.stringify({ path: "src/file.ts", content: "updated" }),
      );
      expect(violations.filter((v) => v.rule === "write-after-edit").length).toBe(0);
    });
  });

  describe("repeated-same-tool rule", () => {
    it("should warn when calling the same tool on the same path consecutively", () => {
      const state = createPairValidatorState();
      validateToolCall(state, "read", JSON.stringify({ path: "src/file.ts" }));
      const violations = validateToolCall(
        state,
        "read",
        JSON.stringify({ path: "src/file.ts" }),
      );
      expect(violations.filter((v) => v.rule === "repeated-same-tool").length).toBe(1);
    });

    it("should not warn when calling the same tool on different paths", () => {
      const state = createPairValidatorState();
      validateToolCall(state, "read", JSON.stringify({ path: "src/file1.ts" }));
      const violations = validateToolCall(
        state,
        "read",
        JSON.stringify({ path: "src/file2.ts" }),
      );
      expect(violations.filter((v) => v.rule === "repeated-same-tool").length).toBe(0);
    });
  });

  describe("edit-without-search rule", () => {
    it("should info when editing without read or search", () => {
      const state = createPairValidatorState();
      const violations = validateToolCall(
        state,
        "edit",
        JSON.stringify({ path: "src/file.ts", old_text: "a", new_text: "b" }),
      );
      expect(violations.filter((v) => v.rule === "edit-without-search").length).toBe(1);
    });

    it("should not info when editing after search", () => {
      const state = createPairValidatorState();
      validateToolCall(state, "search", JSON.stringify({ paths: ["src/file.ts"], pattern: "test" }));
      const violations = validateToolCall(
        state,
        "edit",
        JSON.stringify({ path: "src/file.ts", old_text: "a", new_text: "b" }),
      );
      expect(violations.filter((v) => v.rule === "edit-without-search").length).toBe(0);
    });
  });

  describe("validateToolCalls batch", () => {
    it("should validate multiple tool calls in one batch", () => {
      const state = createPairValidatorState();
      const violations = validateToolCalls(state, [
        { name: "edit", args: JSON.stringify({ path: "src/file1.ts", old_text: "a", new_text: "b" }) },
        { name: "edit", args: JSON.stringify({ path: "src/file2.ts", old_text: "c", new_text: "d" }) },
      ]);
      expect(violations.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("formatViolations", () => {
    it("should return empty string for no violations", () => {
      expect(formatViolations([])).toBe("");
    });

    it("should format violations with severity indicators", () => {
      const violations = [
        {
          rule: "test-rule",
          message: "Test message",
          severity: "warning" as const,
          suggestion: "Test suggestion",
          tool: "test",
        },
      ];
      const formatted = formatViolations(violations);
      expect(formatted).toContain("⚠️");
      expect(formatted).toContain("test-rule");
      expect(formatted).toContain("Test message");
    });
  });

  describe("hasCriticalViolation", () => {
    it("should return true for error severity", () => {
      const violations = [
        {
          rule: "test-rule",
          message: "Test",
          severity: "error" as const,
          suggestion: "Fix it",
          tool: "test",
        },
      ];
      expect(hasCriticalViolation(violations)).toBe(true);
    });

    it("should return false for warning severity", () => {
      const violations = [
        {
          rule: "test-rule",
          message: "Test",
          severity: "warning" as const,
          suggestion: "Fix it",
          tool: "test",
        },
      ];
      expect(hasCriticalViolation(violations)).toBe(false);
    });
  });
});