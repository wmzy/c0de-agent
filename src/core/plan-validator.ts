// Plan format validator for Oh-My-OpenAgent (data + functions paradigm).
//
// Validates structured plans for completeness and correctness:
//   - goal is present and non-empty
//   - steps are complete (each has id, title, description)
//   - dependency graph is acyclic (DFS-based cycle detection)
//   - risks section is present and non-empty
//
// Design rules followed:
//   - data + functions only (no class, no this, no enum)
//   - variants tagged via `_tag` field, dispatched via switch on `_tag`
//   - all composite shapes declared with `type`, never `interface`

// ---------------------------------------------------------------------------
// Plan data types
// ---------------------------------------------------------------------------

export type PlanStep = {
  id: string;
  title: string;
  description: string;
  /** IDs of steps this step depends on. */
  dependsOn: string[];
};

export type PlanDependency = {
  from: string;
  to: string;
};

export type PlanRisk = {
  description: string;
  severity: "low" | "medium" | "high";
  mitigation?: string;
};

export type PlanSection = {
  goal: string;
  steps: PlanStep[];
  dependencies: PlanDependency[];
  risks: PlanRisk[];
};

// ---------------------------------------------------------------------------
// Error types (discriminated union via `_tag`)
// ---------------------------------------------------------------------------

export type PlanError =
  | { _tag: "missing_goal" }
  | { _tag: "empty_goal" }
  | { _tag: "missing_steps" }
  | { _tag: "incomplete_step"; stepId: string; missingFields: string[] }
  | { _tag: "duplicate_step_id"; stepId: string; occurrences: number }
  | { _tag: "invalid_step_reference"; fromStep: string; references: string[] }
  | { _tag: "circular_dependency"; cycle: string[] }
  | { _tag: "missing_risks" }
  | { _tag: "risk_missing_mitigation"; riskIndex: number; description: string }
  | { _tag: "orphan_step"; stepId: string };

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export type ValidationResult = {
  valid: boolean;
  errors: PlanError[];
  suggestions: string[];
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function validatePlan(plan: PlanSection): ValidationResult {
  const errors: PlanError[] = [];
  const suggestions: string[] = [];

  validateGoal(plan, errors, suggestions);
  validateSteps(plan, errors, suggestions);
  validateDependencies(plan, errors, suggestions);
  validateRisks(plan, errors, suggestions);

  return {
    valid: errors.length === 0,
    errors,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Goal validation
// ---------------------------------------------------------------------------

function validateGoal(plan: PlanSection, errors: PlanError[], suggestions: string[]): void {
  if (plan.goal === undefined || plan.goal === null) {
    errors.push({ _tag: "missing_goal" });
    suggestions.push("Define a clear goal for the plan.");
    return;
  }

  if (plan.goal.trim().length === 0) {
    errors.push({ _tag: "empty_goal" });
    suggestions.push("Provide a non-empty goal describing what the plan achieves.");
  }

  if (plan.goal.length > 0 && plan.goal.length < 10) {
    suggestions.push(
      "Goal is very short. Consider expanding it to clearly state the desired outcome.",
    );
  }
}

// ---------------------------------------------------------------------------
// Steps validation
// ---------------------------------------------------------------------------

function validateSteps(plan: PlanSection, errors: PlanError[], suggestions: string[]): void {
  if (!plan.steps || plan.steps.length === 0) {
    errors.push({ _tag: "missing_steps" });
    suggestions.push("Add at least one step to the plan.");
    return;
  }

  // Check for duplicate IDs
  const idCounts = new Map<string, number>();
  for (const step of plan.steps) {
    const count = (idCounts.get(step.id) ?? 0) + 1;
    idCounts.set(step.id, count);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      errors.push({ _tag: "duplicate_step_id", stepId: id, occurrences: count });
    }
  }

  // Check each step for completeness
  for (const step of plan.steps) {
    const missingFields: string[] = [];

    if (!step.id || step.id.trim().length === 0) {
      missingFields.push("id");
    }
    if (!step.title || step.title.trim().length === 0) {
      missingFields.push("title");
    }
    if (!step.description || step.description.trim().length === 0) {
      missingFields.push("description");
    }

    if (missingFields.length > 0) {
      errors.push({
        _tag: "incomplete_step",
        stepId: step.id || "(unnamed)",
        missingFields,
      });
    }
  }

  // Detect orphan steps (no incoming or outgoing dependencies, unless single step)
  if (plan.steps.length > 1) {
    const referenced = new Set<string>();
    for (const step of plan.steps) {
      for (const dep of step.dependsOn) {
        referenced.add(dep);
      }
    }
    // Also count steps that depend on others as non-orphan
    const hasDeps = new Set<string>();
    for (const step of plan.steps) {
      if (step.dependsOn.length > 0) {
        hasDeps.add(step.id);
      }
    }

    for (const step of plan.steps) {
      if (!referenced.has(step.id) && !hasDeps.has(step.id)) {
        suggestions.push(
          `Step "${step.id}" has no dependencies — consider linking it to the workflow or removing it.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Dependency validation (cycle detection via DFS + reference checking)
// ---------------------------------------------------------------------------

function validateDependencies(plan: PlanSection, errors: PlanError[], suggestions: string[]): void {
  if (!plan.steps || plan.steps.length === 0) return;

  const stepIds = new Set(plan.steps.map((s) => s.id));

  // Build adjacency list from step.dependsOn
  const graph = new Map<string, string[]>();
  for (const step of plan.steps) {
    graph.set(step.id, []);
  }

  // Check for invalid references
  for (const step of plan.steps) {
    const invalidRefs: string[] = [];
    for (const dep of step.dependsOn) {
      if (!stepIds.has(dep)) {
        invalidRefs.push(dep);
      } else {
        // Edge: step depends on dep → dep must complete before step
        // In the graph, edge goes from step → dep (step points to what it needs)
        const adj = graph.get(step.id);
        if (adj) adj.push(dep);
      }
    }
    if (invalidRefs.length > 0) {
      errors.push({
        _tag: "invalid_step_reference",
        fromStep: step.id,
        references: invalidRefs,
      });
    }
  }

  // Also include explicit PlanDependency edges
  for (const dep of plan.dependencies) {
    if (!stepIds.has(dep.from)) {
      errors.push({
        _tag: "invalid_step_reference",
        fromStep: "(dependency list)",
        references: [dep.from],
      });
    }
    if (!stepIds.has(dep.to)) {
      errors.push({
        _tag: "invalid_step_reference",
        fromStep: "(dependency list)",
        references: [dep.to],
      });
    }
    if (stepIds.has(dep.from) && stepIds.has(dep.to)) {
      // PlanDependency { from, to } means "from must complete before to".
      // Edge direction: to depends on from → graph edge to → from.
      const adj = graph.get(dep.to);
      if (adj && !adj.includes(dep.from)) {
        adj.push(dep.from);
      }
    }
  }

  // DFS-based cycle detection
  const cycle = detectCycle(graph);
  if (cycle.length > 0) {
    errors.push({ _tag: "circular_dependency", cycle });
    suggestions.push(`Break the circular dependency: ${cycle.join(" → ")}.`);
  }
}

// ---------------------------------------------------------------------------
// Cycle detection (DFS with three-color marking)
//
// Returns the first cycle found as an ordered list of step IDs, or an empty
// array if the graph is acyclic.
// ---------------------------------------------------------------------------

function detectCycle(graph: Map<string, string[]>): string[] {
  const WHITE = 0; // unvisited
  const GRAY = 1; // in current DFS path
  const BLACK = 2; // fully explored

  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  for (const node of graph.keys()) {
    color.set(node, WHITE);
    parent.set(node, null);
  }

  for (const start of graph.keys()) {
    if (color.get(start) !== WHITE) continue;

    // Iterative DFS to avoid stack overflow on large graphs
    const stack: Array<{ node: string; phase: "enter" | "exit" }> = [
      { node: start, phase: "enter" },
    ];

    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) continue;
      const node = frame.node;

      if (frame.phase === "enter") {
        color.set(node, GRAY);
        stack.push({ node, phase: "exit" });

        const neighbors = graph.get(node) ?? [];
        for (const neighbor of neighbors) {
          const c = color.get(neighbor) ?? WHITE;
          if (c === GRAY) {
            // Found a cycle — reconstruct it
            return reconstructCycle(node, neighbor, parent);
          }
          if (c === WHITE) {
            parent.set(neighbor, node);
            stack.push({ node: neighbor, phase: "enter" });
          }
        }
      } else {
        color.set(node, BLACK);
      }
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Reconstruct cycle path from back-edge detection
// ---------------------------------------------------------------------------

function reconstructCycle(
  current: string,
  backEdgeTarget: string,
  parent: Map<string, string | null>,
): string[] {
  const cycle: string[] = [backEdgeTarget];
  let node = current;

  while (node !== backEdgeTarget) {
    cycle.push(node);
    const p = parent.get(node);
    if (p === null || p === undefined) break;
    node = p;
  }

  cycle.push(backEdgeTarget);
  cycle.reverse();
  return cycle;
}

// ---------------------------------------------------------------------------
// Risk validation
// ---------------------------------------------------------------------------

function validateRisks(plan: PlanSection, errors: PlanError[], suggestions: string[]): void {
  if (!plan.risks || plan.risks.length === 0) {
    errors.push({ _tag: "missing_risks" });
    suggestions.push(
      "Identify potential risks. Even a brief note about what could go wrong improves plan quality.",
    );
    return;
  }

  for (let i = 0; i < plan.risks.length; i++) {
    const risk = plan.risks[i];

    if (!risk.description || risk.description.trim().length === 0) {
      suggestions.push(`Risk at index ${i} has no description — clarify what the risk is.`);
    }

    if (!risk.mitigation || risk.mitigation.trim().length === 0) {
      errors.push({
        _tag: "risk_missing_mitigation",
        riskIndex: i,
        description: risk.description || "(empty)",
      });
    }
  }

  // Suggest ordering by severity if high-severity risks lack mitigation
  const highRisks = plan.risks.filter((r) => r.severity === "high");
  const unmitigatedHigh = highRisks.filter(
    (r) => !r.mitigation || r.mitigation.trim().length === 0,
  );
  if (unmitigatedHigh.length > 0) {
    suggestions.push(
      `${unmitigatedHigh.length} high-severity risk(s) lack mitigation — these should be addressed first.`,
    );
  }
}
