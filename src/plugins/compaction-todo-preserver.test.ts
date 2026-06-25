// Tests for compaction todo preserver plugin.

import { describe, expect, it } from "vitest";

import {
  buildTodoInjection,
  extractTodos,
  preserveTodosInCompaction,
} from "./compaction-todo-preserver";

// ---------------------------------------------------------------------------
// extractTodos
// ---------------------------------------------------------------------------

describe("extractTodos", () => {
  it("extracts // TODO comments", () => {
    const messages = [
      { role: "assistant" as const, content: "// TODO: fix the error handling in parser" },
    ];
    const result = extractTodos(messages);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.tag).toBe("TODO");
    expect(result.items[0]!.text).toContain("fix the error handling");
  });

  it("extracts # TODO comments", () => {
    const messages = [
      { role: "assistant" as const, content: "# FIXME: broken link in readme" },
    ];
    const result = extractTodos(messages);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.tag).toBe("FIXME");
    expect(result.items[0]!.text).toContain("broken link");
  });

  it("extracts /* TODO */ block comments", () => {
    const messages = [
      { role: "assistant" as const, content: "/* HACK: temporary workaround for race condition */" },
    ];
    const result = extractTodos(messages);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.tag).toBe("HACK");
    expect(result.items[0]!.text).toContain("temporary workaround");
  });

  it("extracts -- TODO SQL-style comments", () => {
    const messages = [
      { role: "assistant" as const, content: "-- TODO: add index on sessions.created_at" },
    ];
    const result = extractTodos(messages);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.tag).toBe("TODO");
    expect(result.items[0]!.text).toContain("add index");
  });

  it("extracts <!-- TODO --> HTML-style comments", () => {
    const messages = [
      { role: "assistant" as const, content: "<!-- FIXME: accessibility audit needed -->" },
    ];
    const result = extractTodos(messages);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.tag).toBe("FIXME");
    expect(result.items[0]!.text).toContain("accessibility audit");
  });

  it("extracts bare TODO markers in prose", () => {
    const messages = [
      { role: "assistant" as const, content: "TODO: refactor the auth module to use sessions" },
    ];
    const result = extractTodos(messages);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.tag).toBe("TODO");
    expect(result.items[0]!.text).toContain("refactor the auth module");
  });

  it("extracts multiple TODOs from a single message", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          "// TODO: add error handling",
          "# FIXME: memory leak in cache",
          "/* HACK: use polling until websocket is ready */",
        ].join("\n"),
      },
    ];
    const result = extractTodos(messages);
    expect(result.items).toHaveLength(3);
    const tags = result.items.map((i) => i.tag);
    expect(tags).toContain("TODO");
    expect(tags).toContain("FIXME");
    expect(tags).toContain("HACK");
  });

  it("deduplicates identical TODO items", () => {
    const messages = [
      { role: "assistant" as const, content: "// TODO: fix parser" },
      { role: "user" as const, content: "// TODO: fix parser" },
    ];
    const result = extractTodos(messages);
    expect(result.items).toHaveLength(1);
  });

  it("returns empty for messages with no TODOs", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi there, nothing to do" },
    ];
    const result = extractTodos(messages);
    expect(result.items).toHaveLength(0);
  });

  it("extracts TODOs from array content (multipart messages)", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "text", text: "// TODO: handle multipart content" },
        ],
      },
    ];
    const result = extractTodos(messages);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.text).toContain("handle multipart content");
  });

  it("does not match TODO as a substring (word boundary)", () => {
    const messages = [
      { role: "assistant" as const, content: "The TODOS list is empty" },
    ];
    const result = extractTodos(messages);
    expect(result.items).toHaveLength(0);
  });

  it("extracts TODOs across multiple messages", () => {
    const messages = [
      { role: "assistant" as const, content: "// TODO: first item" },
      { role: "user" as const, content: "# FIXME: second item" },
      { role: "assistant" as const, content: "/* HACK: third item */" },
    ];
    const result = extractTodos(messages);
    expect(result.items).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// buildTodoInjection
// ---------------------------------------------------------------------------

describe("buildTodoInjection", () => {
  it("formats TODO items grouped by tag", () => {
    const todos = {
      items: [
        { tag: "TODO" as const, text: "add tests" },
        { tag: "FIXME" as const, text: "broken link" },
        { tag: "HACK" as const, text: "temp workaround" },
      ],
    };
    const text = buildTodoInjection(todos);
    expect(text).toContain("Outstanding TODOs");
    expect(text).toContain("[TODO] add tests");
    expect(text).toContain("[FIXME] broken link");
    expect(text).toContain("[HACK] temp workaround");
  });

  it("returns empty string when no items", () => {
    const todos = { items: [] };
    const text = buildTodoInjection(todos);
    expect(text).toBe("");
  });

  it("includes source when present", () => {
    const todos = {
      items: [
        { tag: "TODO" as const, text: "add tests", source: "src/parser.ts" },
      ],
    };
    const text = buildTodoInjection(todos);
    expect(text).toContain("(src/parser.ts)");
  });

  it("omits source when not present", () => {
    const todos = {
      items: [{ tag: "TODO" as const, text: "add tests" }],
    };
    const text = buildTodoInjection(todos);
    expect(text).not.toContain("()");
  });
});

// ---------------------------------------------------------------------------
// preserveTodosInCompaction
// ---------------------------------------------------------------------------

describe("preserveTodosInCompaction", () => {
  it("appends TODOs to compaction summary", () => {
    const messages = [
      {
        role: "system" as const,
        content: "[Compacted summary of earlier conversation]\n- assistant: some summary",
      },
      {
        role: "assistant" as const,
        content: "// TODO: fix the parser before shipping",
      },
    ];
    const result = preserveTodosInCompaction(messages as unknown[]) as Array<{
      role: string;
      content: string;
    }>;
    expect(result).toHaveLength(2);
    const summary = result[0]!;
    expect(summary.content).toContain("Outstanding TODOs");
    expect(summary.content).toContain("[TODO] fix the parser");
  });

  it("returns original messages when no compaction summary present", () => {
    const messages = [
      { role: "user" as const, content: "// TODO: do something" },
      { role: "assistant" as const, content: "ok" },
    ];
    const result = preserveTodosInCompaction(messages as unknown[]);
    expect(result).toBe(messages);
  });

  it("returns original messages when no TODOs found", () => {
    const messages = [
      {
        role: "system" as const,
        content: "[Compacted summary of earlier conversation]\n- assistant: no todos here",
      },
      {
        role: "assistant" as const,
        content: "nothing to do",
      },
    ];
    const result = preserveTodosInCompaction(messages as unknown[]);
    expect(result).toBe(messages);
  });

  it("does not double-inject when TODOs are already preserved", () => {
    const messages = [
      {
        role: "system" as const,
        content:
          "[Compacted summary of earlier conversation]\n## Outstanding TODOs\n- [TODO] already preserved",
      },
      {
        role: "assistant" as const,
        content: "// TODO: already preserved",
      },
    ];
    const result = preserveTodosInCompaction(messages as unknown[]);
    expect(result).toBe(messages);
  });

  it("preserves existing summary content", () => {
    const messages = [
      {
        role: "system" as const,
        content: "[Compacted summary of earlier conversation]\n- assistant: did some work",
      },
      {
        role: "assistant" as const,
        content: "// TODO: finish the job",
      },
    ];
    const result = preserveTodosInCompaction(messages as unknown[]) as Array<{
      role: string;
      content: string;
    }>;
    expect(result[0]!.content).toContain("did some work");
    expect(result[0]!.content).toContain("[TODO] finish the job");
  });

  it("preserves multiple TODO types in one compaction", () => {
    const messages = [
      {
        role: "system" as const,
        content: "[Compacted summary of earlier conversation]",
      },
      {
        role: "assistant" as const,
        content: [
          "// TODO: add error handling",
          "# FIXME: memory leak",
          "/* HACK: polling workaround */",
        ].join("\n"),
      },
    ];
    const result = preserveTodosInCompaction(messages as unknown[]) as Array<{
      role: string;
      content: string;
    }>;
    const summary = result[0]!.content;
    expect(summary).toContain("[TODO] add error handling");
    expect(summary).toContain("[FIXME] memory leak");
    expect(summary).toContain("[HACK] polling workaround");
  });

  it("detects summary by id prefix", () => {
    const messages = [
      {
        id: "summary-msg-123",
        role: "system" as const,
        content: "[Compacted summary of earlier conversation]",
      },
      {
        role: "assistant" as const,
        content: "// TODO: track by id",
      },
    ];
    const result = preserveTodosInCompaction(messages as unknown[]) as Array<{
      content: string;
    }>;
    expect(result[0]!.content).toContain("[TODO] track by id");
  });
});
