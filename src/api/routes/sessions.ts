// Session routes (§9.2).
//
// POST   /api/sessions              — create a new session
// GET    /api/sessions              — list all sessions
// GET    /api/sessions/:id          — get session detail
// POST   /api/sessions/:id/fork     — fork a session at a message index
// GET    /api/sessions/:id/export   — export session in json/markdown/html
// DELETE /api/sessions/:id          — delete a session
// GET    /api/sessions/:id/messages — list messages for a session

import { Hono } from "hono";
import { runHooks } from "../../plugins/hooks";
import {
  createSession as dbCreateSession,
  deleteSession as dbDeleteSession,
  exportSession,
  EXPORT_MIME,
  forkSession,
  getSession as dbGetSession,
  getMessages as dbGetMessages,
  listSessions as dbListSessions,
} from "../../session";
import { globalSessionStore as memStore } from "../global-store";
import type { SessionStore } from "../../session/types";
import {
  badRequest,
  notFound,
  parseQueryInt,
  safeJson,
  serializeMessage,
  serializeSession,
} from "../helpers";
import type { ServerDeps } from "../index";
import { cleanupAgent } from "../state";

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSessionRoutes(app: Hono, deps: ServerDeps): void {
  // Use injected session store or fallback to module-level store
  // Use injected session store (from vite.config.ts shared instance)
  const getStore = (): SessionStore => {
    if (deps.sessionStore) return deps.sessionStore;
    // Fallback: create and cache a module-level store
    return memStore;
  };

  // POST /api/sessions — create a new session.
  app.post("/api/sessions", async (c) => {
    const body = await safeJson(c);
    const title = typeof body?.title === "string" ? body.title : undefined;
    const projectId = typeof body?.projectId === "string" ? body.projectId : undefined;
    const store = getStore();
    const session = await store.create(title, projectId);

    // Trigger session:create hook (§3.7) — failure must not interrupt.
    if (deps.pluginRegistry) {
      try {
        await runHooks(deps.pluginRegistry, "session:create", {
          session: {
            id: session.id,
            title: session.title,
            parentId: session.parentId ?? null,
            branchPoint: session.branchPoint ?? null,
            metadata: session.metadata ?? {},
            createdAt: session.createdAt.getTime(),
            updatedAt: session.updatedAt.getTime(),
          },
        });
      } catch {
        // Hook failure must not interrupt session creation.
      }
    }

    return c.json(serializeSession(session), 201);
  });

  // GET /api/sessions — list all sessions.
  // Supports ?projectId=xxx to filter by project.
  app.get("/api/sessions", async (c) => {
    const projectId = c.req.query("projectId");
    const store = getStore();
    const sessions = await store.list(projectId);
    return c.json(sessions.map(serializeSession));
  });

  // GET /api/sessions/:id — get session detail.
  app.get("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const store = getStore();
    const session = await store.get(id);
    if (!session) return notFound(c, `Session not found: ${id}`);
    return c.json(serializeSession(session));
  });

  // POST /api/sessions/:id/fork — fork a session at a message index.
  app.post("/api/sessions/:id/fork", async (c) => {
    const id = c.req.param("id");
    const body = await safeJson(c);
    const messageIndex = typeof body?.messageIndex === "number" ? body.messageIndex : 0;
    try {
      const fork = await forkSession(deps.db, id, messageIndex);

      // Trigger session:fork hook (§3.7) — failure must not interrupt.
      if (deps.pluginRegistry) {
        try {
          const sourceSession = await getStore().get(id);
          if (sourceSession) {
            await runHooks(deps.pluginRegistry, "session:fork", {
              source: {
                id: sourceSession.id,
                title: sourceSession.title,
                parentId: sourceSession.parentId ?? null,
                branchPoint: sourceSession.branchPoint ?? null,
                metadata: sourceSession.metadata ?? {},
                createdAt: sourceSession.createdAt.getTime(),
                updatedAt: sourceSession.updatedAt.getTime(),
              },
              fork: {
                id: fork.id,
                title: fork.title,
                parentId: fork.parentId ?? null,
                branchPoint: fork.branchPoint ?? null,
                metadata: fork.metadata ?? {},
                createdAt: fork.createdAt.getTime(),
                updatedAt: fork.updatedAt.getTime(),
              },
            });
          }
        } catch {
          // Hook failure must not interrupt session fork.
        }
      }

      return c.json(serializeSession(fork), 201);
    } catch (err) {
      return badRequest(c, String(err instanceof Error ? err.message : err));
    }
  });

  // GET /api/sessions/:id/export — export session in json/markdown/html.
  app.get("/api/sessions/:id/export", async (c) => {
    const id = c.req.param("id");
    const store = getStore();
    const session = await store.get(id);
    if (!session) return notFound(c, `Session not found: ${id}`);

    const formatParam = c.req.query("format") ?? "json";
    const validFormats = ["json", "markdown", "html"] as const;
    type ValidFormat = (typeof validFormats)[number];
    const format = validFormats.includes(formatParam as ValidFormat)
      ? (formatParam as ValidFormat)
      : "json";

    try {
      const data = await exportSession(deps.db, id, format);
      const mime = EXPORT_MIME[format];
      const ext = format === "markdown" ? ".md" : format === "html" ? ".html" : ".json";
      const filename = `session-${id}${ext}`;

      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    } catch (err) {
      return badRequest(c, String(err instanceof Error ? err.message : err));
    }
  });

  // DELETE /api/sessions/:id — delete a session.
  app.delete("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const store = getStore();
    const session = await store.get(id);
    if (!session) return notFound(c, `Session not found: ${id}`);
    // Also clean up any active agent for this session.
    cleanupAgent(id);
    await store.delete(id);
    return c.json({ deleted: true });
  });

  // GET /api/sessions/:id/messages — list messages for a session.
  app.get("/api/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const store = getStore();
    const session = await store.get(id);
    if (!session) return notFound(c, `Session not found: ${id}`);
    const msgs = await store.getMessages(id);
    return c.json(msgs.map(serializeMessage));
  });
}
