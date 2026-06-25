// Tests for SnapCompact bitmap compression (renderMessagesToImage).
//
// Uses a mock canvas factory since Node.js test environment has no browser
// Canvas API. The mock measures text width by character count (monospace
// approximation) and captures draw calls for assertion.

import { describe, expect, it } from "vitest";

import type { Message } from "./types";
import { estimateMessagesTokens } from "./context";
import {
  renderMessagesToImage,
  snapCompact,
} from "./snap-compact";

// ---------------------------------------------------------------------------
// Mock canvas — tracks drawText / fillRect calls and produces a Uint8Array
// ---------------------------------------------------------------------------

type DrawCall =
  | { op: "fillRect"; x: number; y: number; w: number; h: number }
  | { op: "fillText"; text: string; x: number; y: number }
  | { op: "font"; value: string }
  | { op: "fillStyle"; value: string };

function mockCanvasFactory(w: number, h: number) {
  const calls: DrawCall[] = [];
  let _font = "";
  let _fillStyle = "";

  const ctx = {
    canvas: { width: w, height: h },
    get font() { return _font; },
    set font(v: string) { _font = v; calls.push({ op: "font", value: v }); },
    get fillStyle() { return _fillStyle; },
    set fillStyle(v: string) { _fillStyle = v; calls.push({ op: "fillStyle", value: v }); },
    measureText(text: string) {
      // Monospace approximation: ~7.8px per char at 13px font-size
      const sizeMatch = _font.match(/(\\d+)px/);
      const px = sizeMatch ? Number(sizeMatch[1]) : 13;
      return { width: text.length * px * 0.6 };
    },
    fillText(text: string, x: number, y: number) {
      calls.push({ op: "fillText", text, x, y });
    },
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({ op: "fillRect", x, y, w, h });
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    closePath() {},
    fill() {},
  } as unknown as CanvasRenderingContext2D;

  return {
    ctx,
    toBuffer: async () => {
      // Return a tiny valid PNG (1x1 transparent pixel) for the mock
      return new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0, 0, 0, 0, // placeholder
      ]);
    },
    calls,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
  role: "user" | "assistant" | "system",
  content: string,
  id = `msg-${Math.random().toString(36).slice(2, 8)}`,
): Message {
  return { id, role, content, createdAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderMessagesToImage", () => {
  it("renders a single user message without errors", async () => {
    const messages = [makeMessage("user", "Hello, world!")];
    const mock = mockCanvasFactory(800, 600);
    const result = await renderMessagesToImage(messages, undefined, mockCanvasFactory.bind(null, 800, 600) as any);

    expect(result).toBeInstanceOf(Uint8Array);
    // PNG signature
    expect(result[0]).toBe(0x89);
    expect(result[1]).toBe(0x50); // 'P'
  });

  it("renders messages with code blocks", async () => {
    const messages = [
      makeMessage("user", "Write a function"),
      makeMessage("assistant", "Here's the code:\n\n```typescript\nfunction hello(): string {\n  return \"world\";\n}\n```"),
    ];

    const result = await renderMessagesToImage(messages, undefined, (w: number, h: number) => mockCanvasFactory(w, h) as any);
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it("renders messages with markdown formatting", async () => {
    const messages = [
      makeMessage("assistant", "# Heading\n\nSome **bold** and *italic* text.\n\n- bullet one\n- bullet two\n\n`inline code` here."),
    ];

    const result = await renderMessagesToImage(messages, undefined, (w: number, h: number) => mockCanvasFactory(w, h) as any);
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it("handles multiple messages from different roles", async () => {
    const messages = [
      makeMessage("system", "You are a helpful assistant."),
      makeMessage("user", "What is TypeScript?"),
      makeMessage("assistant", "TypeScript is a typed superset of JavaScript."),
      makeMessage("user", "Show me an example."),
      makeMessage("assistant", "```ts\nconst x: number = 42;\n```"),
    ];

    const result = await renderMessagesToImage(messages, undefined, (w: number, h: number) => mockCanvasFactory(w, h) as any);
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it("respects maxMessages option", async () => {
    const messages = Array.from({ length: 100 }, (_, i) =>
      makeMessage(i % 2 === 0 ? "user" : "assistant", `Message ${i}`),
    );

    // Should not throw even with many messages
    const result = await renderMessagesToImage(
      messages,
      { maxMessages: 5 },
      (w: number, h: number) => mockCanvasFactory(w, h) as any,
    );
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it("respects maxCharsPerMessage option", async () => {
    const longText = "x".repeat(10_000);
    const messages = [makeMessage("assistant", longText)];

    const result = await renderMessagesToImage(
      messages,
      { maxCharsPerMessage: 100 },
      (w: number, h: number) => mockCanvasFactory(w, h) as any,
    );
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it("handles MessageContentPart[] content", async () => {
    const messages: Message[] = [{
      id: "msg-parts",
      role: "assistant",
      content: [
        { _tag: "text", text: "Here is the file:" },
        { _tag: "reference", path: "src/index.ts", startLine: 1, endLine: 10 },
      ],
      createdAt: Date.now(),
    }];

    const result = await renderMessagesToImage(messages, undefined, (w: number, h: number) => mockCanvasFactory(w, h) as any);
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it("handles empty messages array", async () => {
    const result = await renderMessagesToImage([], undefined, (w: number, h: number) => mockCanvasFactory(w, h) as any);
    expect(result).toBeInstanceOf(Uint8Array);
  });
});

describe("snapCompact", () => {
  it("returns compression metadata", async () => {
    const messages = [
      makeMessage("user", "Hello!"),
      makeMessage("assistant", "Hi there! How can I help you today?"),
    ];

    const result = await snapCompact(messages, undefined, (w: number, h: number) => mockCanvasFactory(w, h) as any);

    expect(result.image).toBeInstanceOf(Uint8Array);
    expect(result.messageCount).toBe(2);
    expect(result.originalTokens).toBeGreaterThan(0);
    expect(result.imageTokenEstimate).toBeGreaterThan(0);
    expect(result.compressionRatio).toBeGreaterThan(0);
  });

  it("estimates original tokens correctly", async () => {
    const messages = [
      makeMessage("user", "This is a test message with some content."),
    ];

    const result = await snapCompact(messages, undefined, (w: number, h: number) => mockCanvasFactory(w, h) as any);
    const expectedTokens = estimateMessagesTokens(messages);
    expect(result.originalTokens).toBe(expectedTokens);
  });

  it("handles custom imageTokenEstimate", async () => {
    const messages = [makeMessage("user", "Short")];

    const result = await snapCompact(
      messages,
      { imageTokenEstimate: 100 },
      (w: number, h: number) => mockCanvasFactory(w, h) as any,
    );

    expect(result.imageTokenEstimate).toBe(100);
  });

  it("handles many messages for compression ratio", async () => {
    const messages = Array.from({ length: 50 }, (_, i) =>
      makeMessage(
        i % 2 === 0 ? "user" : "assistant",
        `Message ${i}: ${"lorem ipsum ".repeat(20)}`,
      ),
    );

    const result = await snapCompact(messages, undefined, (w: number, h: number) => mockCanvasFactory(w, h) as any);
    expect(result.messageCount).toBe(50);
    expect(result.compressionRatio).toBeGreaterThan(1);
  });
});
