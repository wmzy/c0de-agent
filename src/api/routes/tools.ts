// Tool routes (§9.2, §20.2).
//
// GET  /api/tools                    — list available tools
// POST /api/tools/confirm            — confirm or deny a pending tool execution
// GET  /api/sessions/:id/llm-details — list all LLM call details for a session
// GET  /api/sessions/:id/llm-details/:callId — get a single LLM call detail

import { Hono } from "hono";
import { listTools } from "../../tools";
import { badRequest, notFound, safeJson } from "../helpers";
import type { ServerDeps } from "../index";
import { activeAgents } from "../state";

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerToolRoutes(app: Hono, deps: ServerDeps): void {
  // GET /api/tools — list available tools.
  app.get("/api/tools", (c) => {
    const tools = listTools(deps.toolRegistry);
    return c.json(
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        permission: t.permission,
      })),
    );
  });

  // POST /api/tools/confirm — confirm or deny a pending tool execution.
  app.post("/api/tools/confirm", async (c) => {
    const body = await safeJson(c);
    const toolCallId = body?.toolCallId;
    const confirmed = body?.confirmed;
    if (!toolCallId || typeof toolCallId !== "string") {
      return badRequest(c, "toolCallId is required");
    }
    if (typeof confirmed !== "boolean") {
      return badRequest(c, "confirmed must be a boolean");
    }

    // Find the agent that has this pending confirmation.
    for (const [sessionId, agent] of Array.from(activeAgents)) {
      const pending = agent.pendingConfirm.get(toolCallId);
      if (pending) {
        pending.resolve(confirmed);
        return c.json({ confirmed, toolCallId, sessionId });
      }
    }

    return notFound(c, `No pending confirmation for toolCallId: ${toolCallId}`);
  });

  // ======================================================================
  // LLM Details (§20.2)
  // ======================================================================

  // GET /api/sessions/:id/llm-details — list all LLM call details for a session.
  app.get("/api/sessions/:id/llm-details", (c) => {
    const id = c.req.param("id");
    const agent = activeAgents.get(id);
    if (!agent) {
      return notFound(c, `No active agent for session: ${id}`);
    }
    const details = [...agent.state.llmDetails].sort((a, b) => a.timestamp - b.timestamp);
    return c.json(details);
  });

  // GET /api/sessions/:id/llm-details/:callId — get a single LLM call detail.
  app.get("/api/sessions/:id/llm-details/:callId", (c) => {
    const id = c.req.param("id");
    const callId = c.req.param("callId");
    const agent = activeAgents.get(id);
    if (!agent) {
      return notFound(c, `No active agent for session: ${id}`);
    }
    const detail = agent.state.llmDetails.find((d) => d.id === callId);
    if (!detail) {
      return notFound(c, `LLM detail not found: ${callId}`);
    }
    return c.json(detail);
  });
}
