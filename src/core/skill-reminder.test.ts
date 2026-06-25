// Tests for skill-reminder.ts
//
// Covers:
//   - detectCategory: single-match, no-match, case-insensitivity
//   - detectAllCategories: multi-match ordering
//   - getReminder: output shape for known categories
//   - buildSkillReminders: combined output, empty on no match
//   - CATEGORIES: shape validation

import { describe, expect, it } from "vitest";

import {
  CATEGORIES,
  buildSkillReminders,
  detectAllCategories,
  detectCategory,
  getReminder,
} from "./skill-reminder";

// ---------------------------------------------------------------------------
// CATEGORIES — shape validation
// ---------------------------------------------------------------------------

describe("CATEGORIES", () => {
  it("is a non-empty array", () => {
    expect(CATEGORIES.length).toBeGreaterThan(0);
  });

  it("each category has name, description, and keywords", () => {
    for (const cat of CATEGORIES) {
      expect(typeof cat.name).toBe("string");
      expect(cat.name.length).toBeGreaterThan(0);
      expect(typeof cat.description).toBe("string");
      expect(cat.description.length).toBeGreaterThan(0);
      expect(Array.isArray(cat.keywords)).toBe(true);
      expect(cat.keywords.length).toBeGreaterThan(0);
    }
  });

  it("category names are unique", () => {
    const names = CATEGORIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// detectCategory
// ---------------------------------------------------------------------------

describe("detectCategory", () => {
  it("returns null for empty string", () => {
    expect(detectCategory("")).toBeNull();
  });

  it("returns null for no matching keywords", () => {
    expect(detectCategory("hello world foo bar")).toBeNull();
  });

  it("detects 'testing' category", () => {
    const cat = detectCategory("write a unit test for the parser");
    expect(cat).not.toBeNull();
    expect(cat!.name).toBe("testing");
  });

  it("detects 'debugging' category", () => {
    const cat = detectCategory("there's a crash in the auth module");
    expect(cat).not.toBeNull();
    expect(cat!.name).toBe("debugging");
  });

  it("detects 'refactoring' category", () => {
    const cat = detectCategory("please refactor this function to be cleaner");
    expect(cat).not.toBeNull();
    expect(cat!.name).toBe("refactoring");
  });

  it("detects 'performance' category", () => {
    const cat = detectCategory("this endpoint is very slow, optimize it");
    expect(cat).not.toBeNull();
    expect(cat!.name).toBe("performance");
  });

  it("detects 'security' category", () => {
    const cat = detectCategory("check for XSS vulnerabilities in the form");
    expect(cat).not.toBeNull();
    expect(cat!.name).toBe("security");
  });

  it("detects 'documentation' category", () => {
    const cat = detectCategory("add jsdoc comments to the public API");
    expect(cat).not.toBeNull();
    expect(cat!.name).toBe("documentation");
  });

  it("detects 'architecture' category", () => {
    const cat = detectCategory("we need to rethink the module structure");
    expect(cat).not.toBeNull();
    expect(cat!.name).toBe("architecture");
  });

  it("detects 'database' category", () => {
    const cat = detectCategory("write a migration for the users table");
    expect(cat).not.toBeNull();
    expect(cat!.name).toBe("database");
  });

  it("detects 'ui' category", () => {
    const cat = detectCategory("the modal component needs better styling");
    expect(cat).not.toBeNull();
    expect(cat!.name).toBe("ui");
  });

  it("detects 'api' category", () => {
    const cat = detectCategory("add a new REST endpoint for users");
    expect(cat).not.toBeNull();
    expect(cat!.name).toBe("api");
  });

  it("is case-insensitive", () => {
    expect(detectCategory("DEBUG THIS BUG")!.name).toBe("debugging");
    expect(detectCategory("Write A UNIT TEST")!.name).toBe("testing");
  });

  it("matches partial keywords via word boundaries", () => {
    // "test" should match in "testing" since \btest\b won't match "testing"
    // Actually, "testing" has keyword "testing" which will match.
    // But "test" keyword should match "test" as a standalone word.
    expect(detectCategory("run the test")!.name).toBe("testing");
    // "testing" keyword should match "testing"
    expect(detectCategory("improve testing coverage")!.name).toBe("testing");
  });

  it("returns first matching category in CATEGORIES order when multiple match", () => {
    // Both 'testing' and 'debugging' keywords appear
    const cat = detectCategory("fix the failing test suite");
    expect(cat).not.toBeNull();
    // 'debugging' keywords include "fix" and "failing", but let's check the order
    // CATEGORIES order: testing comes before debugging
    // "fix" is in debugging keywords, "test" is in testing keywords
    // The function checks in CATEGORIES order, so testing would match first
    // Actually "test" appears in "test suite", so testing matches first
    expect(cat!.name).toBe("testing");
  });
});

// ---------------------------------------------------------------------------
// detectAllCategories
// ---------------------------------------------------------------------------

describe("detectAllCategories", () => {
  it("returns empty array for no matches", () => {
    expect(detectAllCategories("hello world")).toEqual([]);
  });

  it("returns single category for single match", () => {
    const cats = detectAllCategories("write a test");
    expect(cats.length).toBe(1);
    expect(cats[0].name).toBe("testing");
  });

  it("returns multiple categories when multiple keywords match", () => {
    // "fix" (debugging) + "test" (testing) + "performance" (optimize)
    const cats = detectAllCategories("fix the failing test that checks optimize");
    const names = cats.map((c) => c.name);
    expect(names).toContain("testing");
    expect(names).toContain("debugging");
    expect(names).toContain("performance");
  });

  it("preserves CATEGORIES priority order", () => {
    const cats = detectAllCategories("fix the failing test that checks optimize");
    const names = cats.map((c) => c.name);
    // testing index < debugging index < performance index
    const testingIdx = names.indexOf("testing");
    const debuggingIdx = names.indexOf("debugging");
    const perfIdx = names.indexOf("performance");
    expect(testingIdx).toBeLessThan(debuggingIdx);
    expect(debuggingIdx).toBeLessThan(perfIdx);
  });
});

// ---------------------------------------------------------------------------
// getReminder
// ---------------------------------------------------------------------------

describe("getReminder", () => {
  it("includes category name in output", () => {
    const cat = detectCategory("run a test")!;
    const reminder = getReminder(cat);
    expect(reminder).toContain("[Skill Reminder — testing]");
  });

  it("includes category description", () => {
    const cat = detectCategory("run a test")!;
    const reminder = getReminder(cat);
    expect(reminder).toContain(cat.description);
  });

  it("includes recommended hints for known categories", () => {
    const cat = detectCategory("run a test")!;
    const reminder = getReminder(cat);
    expect(reminder).toContain("Recommended approach:");
    expect(reminder).toContain("bash");
  });

  it("returns basic format for unknown category", () => {
    const reminder = getReminder({
      name: "unknown",
      description: "An unknown category.",
      keywords: ["unknown"],
    });
    expect(reminder).toContain("[Skill Reminder — unknown]");
    expect(reminder).toContain("An unknown category.");
    // No "Recommended approach:" for unknown categories
    expect(reminder).not.toContain("Recommended approach:");
  });
});

// ---------------------------------------------------------------------------
// buildSkillReminders
// ---------------------------------------------------------------------------

describe("buildSkillReminders", () => {
  it("returns empty string for no match", () => {
    expect(buildSkillReminders("hello world")).toBe("");
  });

  it("returns reminder for single category", () => {
    const result = buildSkillReminders("write a test");
    expect(result).toContain("[Skill Reminder — testing]");
    expect(result).toContain("Recommended approach:");
  });

  it("returns combined reminders for multiple categories", () => {
    const result = buildSkillReminders("fix the failing test that checks optimize");
    expect(result).toContain("[Skill Reminder — testing]");
    expect(result).toContain("[Skill Reminder — debugging]");
    expect(result).toContain("[Skill Reminder — performance]");
  });

  it("separates multiple reminders with double newline", () => {
    const result = buildSkillReminders("fix the failing test that checks optimize");
    // Should have at least one double newline separating reminders
    expect(result).toContain("\n\n");
  });

  it("is case-insensitive", () => {
    const result = buildSkillReminders("DEBUG THE BUG");
    expect(result).toContain("[Skill Reminder — debugging]");
  });
});
