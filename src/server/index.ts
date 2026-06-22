// @c0de/server - Hono HTTP server + SSE

import { createAgent } from "@c0de/core";
import { createProvider } from "@c0de/llm";
import { createMemoryStore } from "@c0de/session";
import { createDefaultRegistry } from "@c0de/tools";
import { createExecutor } from "@c0de/tools";
import { Hono } from "hono";
import { cors } from "hono/cors";

export const VERSION = "0.0.1";

const app = new Hono();

// CORS
app.use("*", cors());

// Session store (in-memory for now)
const sessionStore = createMemoryStore();

// API Routes
const api = new Hono();

// Create new session
api.post("/sessions", async (c) => {
  const session = await sessionStore.create();
  return c.json(session);
});

// List sessions
api.get("/sessions", async (c) => {
  const sessions = await sessionStore.list();
  return c.json(sessions);
});

// Get session
api.get("/sessions/:id", async (c) => {
  const session = await sessionStore.get(c.req.param("id"));
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json(session);
});

// Delete session
api.delete("/sessions/:id", async (c) => {
  await sessionStore.delete(c.req.param("id"));
  return c.json({ ok: true });
});

// Get session messages
api.get("/sessions/:id/messages", async (c) => {
  const messages = await sessionStore.getMessages(c.req.param("id"));
  return c.json(messages);
});

// Chat endpoint with SSE streaming
api.post("/sessions/:id/chat", async (c) => {
  const sessionId = c.req.param("id");
  const { message } = await c.req.json<{ message: string }>();

  if (!message) {
    return c.json({ error: "Message is required" }, 400);
  }

  // Create provider from env
  const provider = createProvider({
    apiKey: process.env.OPENAI_API_KEY ?? "",
    baseUrl: process.env.OPENAI_BASE_URL,
    model: process.env.MODEL_NAME,
  });

  const registry = createDefaultRegistry();
  const executor = createExecutor(registry);

  const agent = createAgent({
    provider,
    tools: registry,
    executor,
    config: {
      workingDirectory: process.env.WORKING_DIRECTORY ?? process.cwd(),
    },
  });

  // Store user message
  await sessionStore.addMessage(sessionId, {
    role: "user",
    content: message,
  });

  // SSE response
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      try {
        for await (const event of agent.run(message)) {
          // Store assistant messages and tool results
          if (event.type === "message") {
            await sessionStore.addMessage(sessionId, {
              role: "assistant",
              content: event.data as string,
            });
          } else if (event.type === "tool_result") {
            const result = event.data as { output: string; error?: string };
            await sessionStore.addMessage(sessionId, {
              role: "assistant",
              content: result.error ? `Tool error: ${result.error}` : result.output,
            });
          }

          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error) {
        const errorEvent = {
          type: "error",
          data: error instanceof Error ? error.message : String(error),
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

app.route("/api", api);

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
