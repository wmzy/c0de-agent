// Tests for think-mode system in agent.ts
//
// Covers:
//   - detectThinkMode: keyword detection across languages (legacy compat)
//   - classifyThinkMode: multi-mode classification (quick/thorough/creative/auto/none)
//   - selectModelForThinkMode: auto model selection per mode
//   - classifyThinkingContent: thinking content categorization
//   - createThinkModeState / switchThinkMode / resetThinkingState: state management
//   - Lifecycle events

import { afterEach, describe, expect, it } from "vitest";

import {
  clearLifecycleSubscribers,
  createAgent,
  createThinkModeState,
  classifyThinkMode,
  classifyThinkingContent,
  detectThinkMode,
  emitLifecycleEvent,
  resetThinkingState,
  selectModelForThinkMode,
  subscribeLifecycle,
  switchThinkMode,
  unsubscribeLifecycle,
} from "./agent";
import type { AgentConfig, LifecycleEvent } from "./types";

// Minimal config factory for lifecycle tests
function makeConfig(): AgentConfig {
  return {
    provider: "test",
    model: "test-model",
    tools: [],
    plugins: [],
    providerRegistry: { providers: new Map(), fallback: undefined, routing: undefined } as any,
    toolRegistry: { tools: new Map(), executors: new Map() } as any,
  };
}

// ---------------------------------------------------------------------------
// detectThinkMode
// ---------------------------------------------------------------------------

describe("detectThinkMode", () => {
  it("detects English 'think' keyword", () => {
    expect(detectThinkMode("think about this")).toBe(true);
    expect(detectThinkMode("please think carefully")).toBe(true);
  });

  it("detects Chinese keywords", () => {
    expect(detectThinkMode("请思考一下")).toBe(true);
    expect(detectThinkMode("分析一下这个问题")).toBe(true);
    expect(detectThinkMode("推理过程")).toBe(true);
    expect(detectThinkMode("深度思考")).toBe(true);
    expect(detectThinkMode("仔细想想")).toBe(true);
  });

  it("detects reasoning keywords", () => {
    expect(detectThinkMode("reason through this")).toBe(true);
    expect(detectThinkMode("analyze the code")).toBe(true);
    expect(detectThinkMode("step by step")).toBe(true);
    expect(detectThinkMode("think step by step")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(detectThinkMode("THINK about it")).toBe(true);
    expect(detectThinkMode("Think carefully")).toBe(true);
    expect(detectThinkMode("Analyze the problem")).toBe(true);
  });

  it("returns false for normal messages", () => {
    expect(detectThinkMode("hello world")).toBe(false);
    expect(detectThinkMode("what is the weather")).toBe(false);
    expect(detectThinkMode("write a function")).toBe(false);
    expect(detectThinkMode("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyThinkMode — multi-mode classification
// ---------------------------------------------------------------------------

describe("classifyThinkMode", () => {
  it("classifies thorough mode from deep thinking keywords", () => {
    expect(classifyThinkMode("think carefully about this")).toEqual({ _tag: "thorough" });
    expect(classifyThinkMode("think step by step through the problem")).toEqual({ _tag: "thorough" });
    expect(classifyThinkMode("深度思考这个问题")).toEqual({ _tag: "thorough" });
    expect(classifyThinkMode("comprehensive analysis needed")).toEqual({ _tag: "thorough" });
  });

  it("classifies creative mode from brainstorm keywords", () => {
    expect(classifyThinkMode("brainstorm some ideas")).toEqual({ _tag: "creative" });
    expect(classifyThinkMode("let's get creative with this")).toEqual({ _tag: "creative" });
    expect(classifyThinkMode("头脑风暴一下")).toEqual({ _tag: "creative" });
  });

  it("classifies quick mode from speed keywords", () => {
    expect(classifyThinkMode("quick think about this")).toEqual({ _tag: "quick" });
    expect(classifyThinkMode("brief analysis of the issue")).toEqual({ _tag: "quick" });
  });

  it("classifies auto mode from general think keywords", () => {
    expect(classifyThinkMode("think about the architecture")).toEqual({ _tag: "auto" });
    expect(classifyThinkMode("分析一下这个问题")).toEqual({ _tag: "auto" });
  });

  it("returns none for non-thinking messages", () => {
    expect(classifyThinkMode("hello world")).toEqual({ _tag: "none" });
    expect(classifyThinkMode("write a function")).toEqual({ _tag: "none" });
    expect(classifyThinkMode("")).toEqual({ _tag: "none" });
  });

  it("prioritizes thorough over general think keywords", () => {
    expect(classifyThinkMode("think carefully about the design")).toEqual({ _tag: "thorough" });
  });

  it("prioritizes creative over general think keywords", () => {
    expect(classifyThinkMode("let's brainstorm solutions")).toEqual({ _tag: "creative" });
  });
});

// ---------------------------------------------------------------------------
// selectModelForThinkMode — auto model selection
// ---------------------------------------------------------------------------

describe("selectModelForThinkMode", () => {
  it("returns null for none mode", () => {
    const registry = { providers: new Map(), fallback: undefined, routing: undefined } as any;
    expect(selectModelForThinkMode(registry, "none")).toBeNull();
  });

  it("returns null when no providers are configured", () => {
    const registry = { providers: new Map(), fallback: undefined, routing: undefined } as any;
    expect(selectModelForThinkMode(registry, "thorough")).toBeNull();
  });

  it("selects thinking-capable model for thorough mode", () => {
    const providers = new Map();
    providers.set("anthropic", {
      config: {
        models: {
          "claude-opus-4": { supportsThinking: true },
          "claude-3-5-haiku": { supportsThinking: false },
        },
      },
    });
    const registry = { providers, fallback: undefined, routing: undefined } as any;
    const result = selectModelForThinkMode(registry, "thorough");
    expect(result).not.toBeNull();
    expect(result?.model).toBe("claude-opus-4");
  });

  it("selects fast model for quick mode", () => {
    const providers = new Map();
    providers.set("anthropic", {
      config: {
        models: {
          "claude-sonnet-4": { supportsThinking: true },
          "claude-3-5-haiku": { supportsThinking: false },
        },
      },
    });
    const registry = { providers, fallback: undefined, routing: undefined } as any;
    const result = selectModelForThinkMode(registry, "quick");
    expect(result).not.toBeNull();
    expect(result?.model).toBe("claude-3-5-haiku");
  });

  it("selects high-capability model for creative mode", () => {
    const providers = new Map();
    providers.set("anthropic", {
      config: {
        models: {
          "claude-opus-4": { supportsThinking: true },
          "claude-3-5-haiku": { supportsThinking: false },
        },
      },
    });
    const registry = { providers, fallback: undefined, routing: undefined } as any;
    const result = selectModelForThinkMode(registry, "creative");
    expect(result).not.toBeNull();
    expect(result?.model).toBe("claude-opus-4");
  });
});

// ---------------------------------------------------------------------------
// classifyThinkingContent — thinking content categorization
// ---------------------------------------------------------------------------

describe("classifyThinkingContent", () => {
  it("classifies analytical thinking", () => {
    const text = "Let me analyze this problem step by step. The logical deduction shows that because X implies Y, therefore we can conclude...";
    const result = classifyThinkingContent(text);
    expect(result._tag).toBe("analytical");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("classifies creative thinking", () => {
    const text = "What if we imagine a different approach? Let me brainstorm some creative alternatives and innovative solutions...";
    const result = classifyThinkingContent(text);
    expect(result._tag).toBe("creative");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("classifies planning thinking", () => {
    const text = "First I need to plan the implementation. Then we'll design the architecture. Next, implement the core module. Finally, test everything.";
    const result = classifyThinkingContent(text);
    expect(result._tag).toBe("planning");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("classifies verification thinking", () => {
    const text = "Let me verify the test results and check for any errors. I need to confirm the fix works and test all edge cases...";
    const result = classifyThinkingContent(text);
    expect(result._tag).toBe("verification");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("returns general for empty or short text", () => {
    expect(classifyThinkingContent("")).toEqual({ _tag: "general", confidence: 0 });
    expect(classifyThinkingContent("hello")).toEqual({ _tag: "general", confidence: 0.3 });
  });

  it("returns general for text with no matching patterns", () => {
    const text = "The quick brown fox jumps over the lazy dog. This is a simple sentence without any technical keywords.";
    const result = classifyThinkingContent(text);
    expect(result._tag).toBe("general");
  });
});

// ---------------------------------------------------------------------------
// Think-mode state management
// ---------------------------------------------------------------------------

describe("think-mode state management", () => {
  it("createThinkModeState initializes with none mode", () => {
    const state = createThinkModeState();
    expect(state.mode._tag).toBe("none");
    expect(state.classifications).toHaveLength(0);
    expect(state.currentThinkingText).toBe("");
    expect(state.history).toHaveLength(0);
  });

  it("switchThinkMode records history and updates mode", () => {
    const state = createThinkModeState();
    const switched = switchThinkMode(state, { _tag: "thorough" }, "user");
    expect(switched.mode._tag).toBe("thorough");
    expect(switched.history).toHaveLength(1);
    expect(switched.history[0].from).toBe("none");
    expect(switched.history[0].to).toBe("thorough");
    expect(switched.history[0].reason).toBe("user");
  });

  it("switchThinkMode is idempotent for same mode", () => {
    const state = createThinkModeState();
    const switched = switchThinkMode(state, { _tag: "none" }, "user");
    expect(switched).toBe(state);
    expect(switched.history).toHaveLength(0);
  });

  it("switchThinkMode accumulates history", () => {
    let state = createThinkModeState();
    state = switchThinkMode(state, { _tag: "thorough" }, "keyword");
    state = switchThinkMode(state, { _tag: "creative" }, "user");
    state = switchThinkMode(state, { _tag: "none" }, "auto");
    expect(state.history).toHaveLength(3);
    expect(state.history.map((h) => h.to)).toEqual(["thorough", "creative", "none"]);
  });

  it("resetThinkingState clears thinking text and classifications", () => {
    const state: any = {
      mode: { _tag: "thorough" },
      classifications: [{ _tag: "analytical", confidence: 0.8 }],
      currentThinkingText: "some thinking text",
      history: [],
    };
    const reset = resetThinkingState(state);
    expect(reset.currentThinkingText).toBe("");
    expect(reset.classifications).toHaveLength(0);
    expect(reset.mode._tag).toBe("thorough");
  });
});

// ---------------------------------------------------------------------------
// createAgent — thinkMode initialization
// ---------------------------------------------------------------------------

describe("createAgent thinkMode", () => {
  it("initializes thinkMode state", () => {
    const state = createAgent(makeConfig());
    expect(state.thinkMode).toBeDefined();
    expect(state.thinkMode.mode._tag).toBe("none");
    expect(state.thinkMode.classifications).toHaveLength(0);
    expect(state.thinkMode.currentThinkingText).toBe("");
    expect(state.thinkMode.history).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

describe("lifecycle events", () => {
  afterEach(() => {
    // Clean up registry after each test
    const state = createAgent(makeConfig());
    clearLifecycleSubscribers(state);
  });

  it("emits events to subscribed callbacks", () => {
    const state = createAgent(makeConfig());
    const received: LifecycleEvent[] = [];

    subscribeLifecycle(state, (event) => {
      received.push(event);
    });

    emitLifecycleEvent(state, {
      _tag: "agent_start",
      timestamp: 100,
      message: {
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: 100,
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]._tag).toBe("agent_start");
  });

  it("supports unsubscribe", () => {
    const state = createAgent(makeConfig());
    const received: LifecycleEvent[] = [];

    const fn = (event: LifecycleEvent) => {
      received.push(event);
    };

    subscribeLifecycle(state, fn);
    unsubscribeLifecycle(state, fn);

    emitLifecycleEvent(state, {
      _tag: "agent_start",
      timestamp: 100,
      message: {
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: 100,
      },
    });

    expect(received).toHaveLength(0);
  });

  it("supports returned unsubscribe function", () => {
    const state = createAgent(makeConfig());
    const received: LifecycleEvent[] = [];

    const unsub = subscribeLifecycle(state, (event) => {
      received.push(event);
    });
    unsub();

    emitLifecycleEvent(state, {
      _tag: "agent_start",
      timestamp: 100,
      message: {
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: 100,
      },
    });

    expect(received).toHaveLength(0);
  });

  it("handles multiple subscribers independently", () => {
    const state = createAgent(makeConfig());
    const received1: LifecycleEvent[] = [];
    const received2: LifecycleEvent[] = [];

    subscribeLifecycle(state, (e) => received1.push(e));
    subscribeLifecycle(state, (e) => received2.push(e));

    emitLifecycleEvent(state, {
      _tag: "agent_start",
      timestamp: 100,
      message: {
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: 100,
      },
    });

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  it("isolates events by session id", () => {
    const state1 = createAgent(makeConfig());
    const state2 = createAgent(makeConfig());
    const received1: LifecycleEvent[] = [];
    const received2: LifecycleEvent[] = [];

    subscribeLifecycle(state1, (e) => received1.push(e));
    subscribeLifecycle(state2, (e) => received2.push(e));

    emitLifecycleEvent(state1, {
      _tag: "agent_start",
      timestamp: 100,
      message: {
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: 100,
      },
    });

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(0);
  });

  it("survives subscriber throwing an error", () => {
    const state = createAgent(makeConfig());
    const received: LifecycleEvent[] = [];

    subscribeLifecycle(state, () => {
      throw new Error("subscriber error");
    });
    subscribeLifecycle(state, (e) => received.push(e));

    expect(() => {
      emitLifecycleEvent(state, {
        _tag: "agent_start",
        timestamp: 100,
        message: {
          id: "m1",
          role: "user",
          content: "hello",
          createdAt: 100,
        },
      });
    }).not.toThrow();

    expect(received).toHaveLength(1);
  });

  it("emits all 12 lifecycle event variants", () => {
    const state = createAgent(makeConfig());
    const tags = new Set<string>();

    subscribeLifecycle(state, (e) => {
      tags.add(e._tag);
    });

    // Emit every variant
    const msg: LifecycleEvent["_tag"] extends infer T
      ? T extends string
        ? { _tag: T; [k: string]: unknown }
        : never
      : never = {} as any;

    const variants: LifecycleEvent[] = [
      {
        _tag: "agent_start",
        timestamp: 1,
        message: { id: "m1", role: "user", content: "", createdAt: 1 },
      },
      {
        _tag: "turn_start",
        timestamp: 2,
        iteration: 1,
      },
      {
        _tag: "message_start",
        timestamp: 3,
        request: { model: "test", messages: [], stream: true },
      },
      {
        _tag: "message_delta",
        timestamp: 4,
        text: "a",
        accumulated: "ab",
      },
      {
        _tag: "message_end",
        timestamp: 5,
        responseText: "hello",
        hasToolCalls: false,
        toolCount: 0,
      },
      {
        _tag: "tool_execution_start",
        timestamp: 6,
        tool: "read",
        input: "{}",
        callIndex: 0,
        totalCalls: 1,
      },
      {
        _tag: "tool_execution_end",
        timestamp: 7,
        tool: "read",
        input: "{}",
        result: { _tag: "success", output: "ok" },
        latency: 10,
        success: true,
      },
      {
        _tag: "parallel_tool_execution_start",
        timestamp: 8,
        groupIndex: 0,
        totalGroups: 1,
        calls: 2,
      },
      {
        _tag: "parallel_tool_execution_end",
        timestamp: 9,
        groupIndex: 0,
        totalGroups: 1,
        results: 2,
      },
      {
        _tag: "turn_end",
        timestamp: 10,
        iteration: 1,
        hasToolCalls: true,
        toolCallsExecuted: 2,
      },
      {
        _tag: "agent_end",
        timestamp: 11,
        status: { _tag: "idle" },
        reason: "done",
      },
      {
        _tag: "thinking_chunk",
        timestamp: 12,
        text: "hmm",
        accumulated: "hmm",
      },
    ];

    for (const event of variants) {
      emitLifecycleEvent(state, event);
    }

    expect(tags.size).toBe(12);
    for (const variant of variants) {
      expect(tags.has(variant._tag)).toBe(true);
    }
  });

  it("clears all subscribers for a session", () => {
    const state = createAgent(makeConfig());
    const received: LifecycleEvent[] = [];

    subscribeLifecycle(state, (e) => received.push(e));
    clearLifecycleSubscribers(state);

    emitLifecycleEvent(state, {
      _tag: "agent_start",
      timestamp: 100,
      message: {
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: 100,
      },
    });

    expect(received).toHaveLength(0);
  });

  it("subscribeLifecycle return type is callable", () => {
    const state = createAgent(makeConfig());
    const received: LifecycleEvent[] = [];

    const unsub = subscribeLifecycle(state, (e) => received.push(e));
    expect(typeof unsub).toBe("function");

    emitLifecycleEvent(state, {
      _tag: "agent_start",
      timestamp: 100,
      message: {
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: 100,
      },
    });
    expect(received).toHaveLength(1);

    unsub();

    emitLifecycleEvent(state, {
      _tag: "agent_start",
      timestamp: 200,
      message: {
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: 200,
      },
    });
    expect(received).toHaveLength(1); // no second event
  });
});
