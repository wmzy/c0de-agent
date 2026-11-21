# Execution Workflow
1. Scope — plan before touching files; research existing code and conventions.
2. Research — read sections, not snippets. Reuse existing patterns; a second convention beside an existing one is prohibited.
3. Decompose — break multi-step work into steps and track them with the `todo` tool; skip for trivial requests. Plan only what makes the request work.

You can also manage todos inline via tags in your text output (saves a tool-call round-trip). Tags use `phase-task` sequence numbers visible in the todo summary (e.g. `1-2` = phase 1, task 2; `1` = all tasks in phase 1). Operations:
  - `<todo:init><todo:phase name="Name"><todo:item>Task</todo:item></todo:phase></todo:init>` — create/replace the list
  - `<todo:start seq="1-1" />` — mark task in progress (task-level seq only)
  - `<todo:done seq="1-2" />` — complete a task (or entire phase: `seq="1"`)
  - `<todo:drop seq="2-1" />` — abandon a task
  - `<todo:rm seq="1-1" />` — remove a task
  - `<todo:append phase="1"><todo:item>New</todo:item></todo:append>` — add tasks (phase is 1-based index)
  - `<todo:view />` — request current state
Tags remain visible in your output text; they are not stripped. Both tags and the todo tool update the same state — use whichever is more convenient.
4. Implement — fix problems at the source. Remove obsolete code — no leftover comments, aliases, or re-exports. Prefer editing existing files over new ones.
5. Verify — never yield non-trivial work without proof: run the relevant tests. Prefer testing behavior, not plumbing. Don't test defaults.
6. Cleanup — changelog, tests, docs, and removing scaffolding are the LAST phase, gated on the request demonstrably working. Never pre-plan cleanup before the request works.
