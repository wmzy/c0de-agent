// Tests for plan-validator.ts
//
// Covers:
//   - Goal validation (missing, empty, too short)
//   - Steps validation (missing, incomplete, duplicates, orphans)
//   - Dependency validation (invalid refs, circular deps)
//   - Risk validation (missing, no mitigation)
//   - Integration: valid plan passes, composite errors

import { describe, expect, it } from "vitest";

import type { PlanSection } from "./plan-validator";
import { validatePlan } from "./plan-validator";

// ---------------------------------------------------------------------------
// Helper: minimal valid plan
// ---------------------------------------------------------------------------

function validPlan(): PlanSection {
  return {
    goal: "Implement the user authentication system with OAuth2 support",
    steps: [
      {
        id: "setup",
        title: "Set up OAuth2 provider",
        description: "Configure the OAuth2 provider credentials and endpoints.",
        dependsOn: [],
      },
      {
        id: "auth-flow",
        title: "Implement auth flow",
        description: "Build the OAuth2 authorization code flow with PKCE.",
        dependsOn: ["setup"],
      },
      {
        id: "session",
        title: "Session management",
        description: "Create session tokens and refresh logic.",
        dependsOn: ["auth-flow"],
      },
    ],
    dependencies: [
      { from: "setup", to: "auth-flow" },
      { from: "auth-flow", to: "session" },
    ],
    risks: [
      {
        description: "OAuth2 provider may have rate limits",
        severity: "medium",
        mitigation: "Implement exponential backoff on token refresh.",
      },
      {
        description: "Token storage security",
        severity: "high",
        mitigation: "Use encrypted storage with hardware-backed keys.",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Goal validation
// ---------------------------------------------------------------------------

describe("validatePlan — goal", () => {
  it("passes with a well-formed goal", () => {
    const result = validatePlan(validPlan());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails when goal is missing", () => {
    const plan = validPlan();
    (plan as Record<string, unknown>).goal = undefined;
    const result = validatePlan(plan as PlanSection);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({ _tag: "missing_goal" });
  });

  it("fails when goal is empty string", () => {
    const plan = validPlan();
    plan.goal = "   ";
    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({ _tag: "empty_goal" });
  });

  it("suggests expanding a very short goal", () => {
    const plan = validPlan();
    plan.goal = "Fix bug";
    const result = validatePlan(plan);

    expect(result.valid).toBe(true); // short goal is valid, just suggested
    expect(result.suggestions.some((s) => s.includes("very short"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Steps validation
// ---------------------------------------------------------------------------

describe("validatePlan — steps", () => {
  it("fails when steps array is empty", () => {
    const plan = validPlan();
    plan.steps = [];
    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({ _tag: "missing_steps" });
  });

  it("fails when a step has missing title", () => {
    const plan = validPlan();
    plan.steps[0].title = "";
    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        _tag: "incomplete_step",
        stepId: "setup",
        missingFields: ["title"],
      }),
    );
  });

  it("fails when a step has missing description", () => {
    const plan = validPlan();
    plan.steps[1].description = "";
    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        _tag: "incomplete_step",
        stepId: "auth-flow",
        missingFields: ["description"],
      }),
    );
  });

  it("fails when a step has multiple missing fields", () => {
    const plan = validPlan();
    plan.steps[2].title = "";
    plan.steps[2].description = "";
    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        _tag: "incomplete_step",
        stepId: "session",
        missingFields: ["title", "description"],
      }),
    );
  });

  it("detects duplicate step IDs", () => {
    const plan = validPlan();
    plan.steps.push({
      id: "setup",
      title: "Duplicate",
      description: "This has the same ID.",
      dependsOn: [],
    });
    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        _tag: "duplicate_step_id",
        stepId: "setup",
        occurrences: 2,
      }),
    );
  });

  it("suggests linking orphan steps", () => {
    const plan = validPlan();
    plan.steps.push({
      id: "standalone",
      title: "Standalone step",
      description: "Has no deps and nothing depends on it.",
      dependsOn: [],
    });
    const result = validatePlan(plan);

    expect(result.suggestions.some((s) => s.includes("standalone"))).toBe(true);
  });

  it("does not flag single-step plans as orphan", () => {
    const plan = validPlan();
    plan.steps = [{ id: "only", title: "Only step", description: "Just one.", dependsOn: [] }];
    plan.dependencies = [];
    const result = validatePlan(plan);

    // Should not have orphan suggestions for a single-step plan
    expect(result.suggestions.some((s) => s.includes("no dependencies"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dependency validation
// ---------------------------------------------------------------------------

describe("validatePlan — dependencies", () => {
  it("detects invalid step reference in dependsOn", () => {
    const plan = validPlan();
    plan.steps[0].dependsOn = ["nonexistent"];
    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        _tag: "invalid_step_reference",
        fromStep: "setup",
        references: ["nonexistent"],
      }),
    );
  });

  it("detects circular dependency (A → B → A)", () => {
    const plan = validPlan();
    plan.steps = [
      { id: "a", title: "A", description: "Step A", dependsOn: ["b"] },
      { id: "b", title: "B", description: "Step B", dependsOn: ["a"] },
    ];
    plan.dependencies = [];
    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    const cycleErrors = result.errors.filter((e) => e._tag === "circular_dependency");
    expect(cycleErrors.length).toBeGreaterThan(0);
    const cycle = (cycleErrors[0] as { _tag: "circular_dependency"; cycle: string[] }).cycle;
    expect(cycle).toContain("a");
    expect(cycle).toContain("b");
  });

  it("detects three-node circular dependency (A → B → C → A)", () => {
    const plan = validPlan();
    plan.steps = [
      { id: "a", title: "A", description: "Step A", dependsOn: ["c"] },
      { id: "b", title: "B", description: "Step B", dependsOn: ["a"] },
      { id: "c", title: "C", description: "Step C", dependsOn: ["b"] },
    ];
    plan.dependencies = [];
    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    const cycleErrors = result.errors.filter((e) => e._tag === "circular_dependency");
    expect(cycleErrors.length).toBeGreaterThan(0);
    const cycle = (cycleErrors[0] as { _tag: "circular_dependency"; cycle: string[] }).cycle;
    expect(cycle).toContain("a");
    expect(cycle).toContain("b");
    expect(cycle).toContain("c");
  });

  it("passes with a linear dependency chain (no cycle)", () => {
    const plan = validPlan();
    const result = validatePlan(plan);

    const cycleErrors = result.errors.filter((e) => e._tag === "circular_dependency");
    expect(cycleErrors).toHaveLength(0);
  });

  it("passes with a diamond dependency (no cycle)", () => {
    const plan = validPlan();
    plan.steps = [
      { id: "start", title: "Start", description: "Beginning", dependsOn: [] },
      { id: "left", title: "Left", description: "Left path", dependsOn: ["start"] },
      { id: "right", title: "Right", description: "Right path", dependsOn: ["start"] },
      { id: "end", title: "End", description: "Convergence", dependsOn: ["left", "right"] },
    ];
    plan.dependencies = [];
    const result = validatePlan(plan);

    const cycleErrors = result.errors.filter((e) => e._tag === "circular_dependency");
    expect(cycleErrors).toHaveLength(0);
  });

  it("detects invalid reference in explicit dependency list", () => {
    const plan = validPlan();
    plan.dependencies.push({ from: "setup", to: "ghost" });
    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        _tag: "invalid_step_reference",
        references: ["ghost"],
      }),
    );
  });

  it("handles many steps without stack overflow", () => {
    const plan = validPlan();
    // Build a long chain: step-0 → step-1 → ... → step-999
    const steps = Array.from({ length: 1000 }, (_, i) => ({
      id: `step-${i}`,
      title: `Step ${i}`,
      description: `Description for step ${i}.`,
      dependsOn: i > 0 ? [`step-${i - 1}`] : [],
    }));
    plan.steps = steps;
    plan.dependencies = [];
    const result = validatePlan(plan);

    // Should not crash and should detect no cycle
    const cycleErrors = result.errors.filter((e) => e._tag === "circular_dependency");
    expect(cycleErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Risk validation
// ---------------------------------------------------------------------------

describe("validatePlan — risks", () => {
  it("fails when risks array is empty", () => {
    const plan = validPlan();
    plan.risks = [];
    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({ _tag: "missing_risks" });
  });

  it("fails when a risk lacks mitigation", () => {
    const plan = validPlan();
    plan.risks[0].mitigation = undefined;
    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        _tag: "risk_missing_mitigation",
        riskIndex: 0,
        description: "OAuth2 provider may have rate limits",
      }),
    );
  });

  it("suggests addressing high-severity unmitigated risks", () => {
    const plan = validPlan();
    plan.risks = [
      { description: "Data loss", severity: "high" },
      { description: "Minor UI glitch", severity: "low", mitigation: "Ignore for now." },
    ];
    const result = validatePlan(plan);

    expect(result.suggestions.some((s) => s.includes("high-severity"))).toBe(true);
  });

  it("passes with all risks having mitigation", () => {
    const plan = validPlan();
    const result = validatePlan(plan);

    const riskErrors = result.errors.filter(
      (e) => e._tag === "risk_missing_mitigation" || e._tag === "missing_risks",
    );
    expect(riskErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: composite scenarios
// ---------------------------------------------------------------------------

describe("validatePlan — integration", () => {
  it("collects multiple errors simultaneously", () => {
    const plan: PlanSection = {
      goal: "",
      steps: [
        { id: "a", title: "", description: "desc", dependsOn: ["b"] },
        { id: "b", title: "B", description: "", dependsOn: ["a"] },
      ],
      dependencies: [],
      risks: [],
    };
    const result = validatePlan(plan);

    expect(result.valid).toBe(false);
    // Should have: empty_goal, incomplete_step (a missing title),
    // incomplete_step (b missing description), circular_dependency, missing_risks
    const tags = result.errors.map((e) => e._tag);
    expect(tags).toContain("empty_goal");
    expect(tags).toContain("incomplete_step");
    expect(tags).toContain("circular_dependency");
    expect(tags).toContain("missing_risks");
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it("returns empty errors and suggestions for a perfect plan", () => {
    const result = validatePlan(validPlan());

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    // May have suggestions but no errors
  });

  it("validation result shape is correct", () => {
    const result = validatePlan(validPlan());

    expect(result).toHaveProperty("valid");
    expect(result).toHaveProperty("errors");
    expect(result).toHaveProperty("suggestions");
    expect(typeof result.valid).toBe("boolean");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.suggestions)).toBe(true);
  });
});
