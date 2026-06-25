// Chat routes — SSE streaming (§9.3).
//
// POST /api/chat          — send a message and stream agent events via SSE
// POST /api/chat/abort    — abort the running agent for a session
// POST /api/chat/pause    — pause the running agent
// POST /api/chat/resume   — resume a paused agent
// POST /api/chat/steer    — inject a steering message into the running agent

import { Hono } from "hono";
import { abortAgent, injectSteeringMessage, runAgent } from "../../agent";
import type { AgentEvent } from "../../agent";
import { appendMessage } from "../../session";
import { executeTool } from "../../tools";
import { badRequest, notFound, safeJson } from "../helpers";
import type { ServerDeps } from "../index";
import { activeAgents, getOrCreateAgent, waitForConfirm } from "../state";

// ---------------------------------------------------------------------------
// SSE helpers — pure data transformations.
// ---------------------------------------------------------------------------

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function agentEventToSSE(event: AgentEvent): string {
  switch (event._tag) {
    case "text_delta":
      return sseEvent("text_delta", { text: event.text });
    case "tool_call":
      return sseEvent("tool_call", {
        id: event.id,
        tool: event.tool,
        input: event.input,
      });
    case "tool_calls_parallel":
      return sseEvent("tool_calls_parallel", { calls: event.calls });
    case "tool_result":
      return sseEvent("tool_result", {
        id: event.id,
        tool: event.tool,
        output: event.output,
      });
    case "thinking":
      return sseEvent("thinking", { text: event.text });
    case "usage":
      return sseEvent("usage", { input: event.input, output: event.output });
    case "permission_required":
      return sseEvent("permission_required", {
        toolCallId: event.toolCallId,
        tool: event.tool,
        input: event.input,
      });
    case "error":
      return sseEvent("error", { error: event.error });
    case "warning":
      return sseEvent("warning", { message: event.message, severity: event.severity });
    case "think_mode_switch":
      return sseEvent("think_mode_switch", { from: event.from, to: event.to, model: event.model });
    case "thinking_classified":
      return sseEvent("thinking_classified", { classification: event.classification });
    case "done":
      return sseEvent("done", {});
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerChatRoutes(app: Hono, deps: ServerDeps): void {
  // POST /api/chat — send a message and stream agent events via SSE.
  app.post("/api/chat", async (c) => {
    const body = await safeJson(c);
    if (!body?.sessionId || typeof body.sessionId !== "string") {
      return badRequest(c, "sessionId is required");
    }
    if (!body?.message || typeof body.message !== "string") {
      return badRequest(c, "message is required");
    }

    const { sessionId, message: userText } = body as { sessionId: string; message: string };

    // Resolve or create the agent for this session.
    const agent = await getOrCreateAgent(deps, sessionId);

    // Persist the user message.
    await appendMessage(deps.db, sessionId, {
      role: "user",
      content: JSON.stringify([{ _tag: "text", text: userText }]),
    });

    // Build the core Message object for the agent loop.
    const userMessage = {
      id: crypto.randomUUID(),
      role: "user" as const,
      content: [{ _tag: "text" as const, text: userText }],
      sessionId,
      createdAt: Date.now(),
    };

    // Create SSE stream.
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const enqueue = (sse: string) => controller.enqueue(encoder.encode(sse));

        let assistantText = "";
        try {
          for await (const event of runAgent(agent.state, userMessage, agent.config)) {
            // Accumulate assistant text for persistence
            if (event._tag === "text_delta") {
              assistantText += event.text;
            }
            // Handle permission_required: set up confirm flow.
            if (event._tag === "permission_required") {
              agent.pendingConfirm.set(event.toolCallId, {
                resolve: () => {}, // Will be resolved by /api/tools/confirm
                tool: event.tool,
                input: event.input,
              });
            }

            enqueue(agentEventToSSE(event));

            // If permission_required, wait for confirmation before continuing.
            if (event._tag === "permission_required") {
              const confirmed = await waitForConfirm(agent, event.toolCallId);
              if (confirmed) {
                // Execute the tool now that it's confirmed.
                const result = await executeTool(deps.toolRegistry, event.tool, event.input, {
                  cwd: deps.workingDirectory,
                  session: { id: sessionId, cwd: deps.workingDirectory },
                  abort: agent.state.abortController.signal,
                });
                // Emit the tool result as an SSE event.
                enqueue(
                  sseEvent("tool_result", {
                    id: event.toolCallId,
                    tool: event.tool,
                    output: result,
                  }),
                );
                // The agent loop will continue with the tool result
                // already appended by runAgent's internal handling.
              } else {
                // Permission denied — emit a synthetic error.
                enqueue(
                  sseEvent("tool_result", {
                    id: event.toolCallId,
                    tool: event.tool,
                    output: { _tag: "error", error: "Permission denied by user" },
                  }),
                );
              }
            }
          }
        } catch (err) {
          enqueue(
            sseEvent("error", {
              error: { _tag: "unknown", message: String(err) },
            }),
          );
        } finally {
          // Persist assistant response
          if (assistantText) {
            await appendMessage(deps.db, sessionId, {
              role: "assistant",
              content: JSON.stringify([{ _tag: "text", text: assistantText }]),
            });
          }
          enqueue(sseEvent("done", {}));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  // POST /api/chat/abort — abort the running agent for a session.
  app.post("/api/chat/abort", async (c) => {
    const body = await safeJson(c);
    const sessionId = body?.sessionId;
    if (!sessionId || typeof sessionId !== "string") {
      return badRequest(c, "sessionId is required");
    }
    const agent = activeAgents.get(sessionId);
    if (!agent) {
      return notFound(c, `No active agent for session: ${sessionId}`);
    }
    abortAgent(agent.state);
    return c.json({ aborted: true });
  });

  // POST /api/chat/pause — pause the running agent.
  app.post("/api/chat/pause", async (c) => {
    const body = await safeJson(c);
    const sessionId = body?.sessionId;
    if (!sessionId || typeof sessionId !== "string") {
      return badRequest(c, "sessionId is required");
    }
    const agent = activeAgents.get(sessionId);
    if (!agent) {
      return notFound(c, `No active agent for session: ${sessionId}`);
    }
    agent.paused = true;
    agent.state.status = { _tag: "paused", pauseReason: "user requested" };
    return c.json({ paused: true });
  });

  // POST /api/chat/resume — resume a paused agent.
  app.post("/api/chat/resume", async (c) => {
    const body = await safeJson(c);
    const sessionId = body?.sessionId;
    if (!sessionId || typeof sessionId !== "string") {
      return badRequest(c, "sessionId is required");
    }
    const agent = activeAgents.get(sessionId);
    if (!agent) {
      return notFound(c, `No active agent for session: ${sessionId}`);
    }
    agent.paused = false;
    agent.state.status = { _tag: "running", startedAt: Date.now() };
    return c.json({ resumed: true });
  });

  // POST /api/chat/steer — inject a steering message into the running agent.
  app.post("/api/chat/steer", async (c) => {
    const body = await safeJson(c);
    const sessionId = body?.sessionId;
    const message = body?.message;
    if (!sessionId || typeof sessionId !== "string") {
      return badRequest(c, "sessionId is required");
    }
    if (!message || typeof message !== "string") {
      return badRequest(c, "message is required");
    }
    const agent = activeAgents.get(sessionId);
    if (!agent) {
      return notFound(c, `No active agent for session: ${sessionId}`);
    }
    injectSteeringMessage(agent.state, message);
    return c.json({ steered: true });
  });
}
