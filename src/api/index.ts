// Hono HTTP server — API routes per design spec §9.
//
// Implements all §9.2 routes: sessions, chat (SSE), tools, config, files,
// health. Uses data + functions paradigm throughout — no class, no new,
// no this, no obj.method().
//
// SSE streaming (§9.3) uses ReadableStream + TextEncoder. Agent events
// are pushed to the client as `event: <_tag>\ndata: <json>\n\n`.
//
// Dependencies are injected via the `ServerDeps` bag so the app can be
// tested and wired without module-level singletons.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadConfig } from "../core";
import type { Config } from "../core";
import type { DB } from "../db/client";
import type { ProviderRegistry } from "../llm";
import { createDefaultRegistry } from "../tools";
import type { ToolRegistry } from "../tools";
import type { PluginRegistry } from "../plugins/types";
import type { SessionStore } from "../session/types";
import { registerChatRoutes } from "./routes/chat";
import { registerConfigRoutes } from "./routes/config";
import { registerFileRoutes } from "./routes/files";
import { registerProjectRoutes } from "./routes/projects";
import { registerSessionRoutes } from "./routes/sessions";
import { registerToolRoutes } from "./routes/tools";

// ---------------------------------------------------------------------------
// Dependencies bag — the single injection point for the server.
// ---------------------------------------------------------------------------

export type ServerDeps = {
  db: DB;
  config: Config;
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  workingDirectory: string;
  pluginRegistry?: PluginRegistry;
  sessionStore?: SessionStore;
};

// ---------------------------------------------------------------------------
// createApp — factory that wires all routes and returns the Hono app.
// ---------------------------------------------------------------------------

export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();

  // CORS — allow local dev origins.
  app.use(
    "*",
    cors({
      origin: ["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );

  // ======================================================================
  // Health
  // ======================================================================

  app.get("/api/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

  // ======================================================================
  // Register route groups
  // ======================================================================

  registerProjectRoutes(app, deps);
  registerSessionRoutes(app, deps);
  registerChatRoutes(app, deps);
  registerToolRoutes(app, deps);
  registerConfigRoutes(app, deps);
  registerFileRoutes(app, deps);

  return app;
}

// ---------------------------------------------------------------------------
// Default export — a convenience factory that creates the app with a
// default tool registry and loads config from disk.
// ---------------------------------------------------------------------------

export async function createServerApp(opts: {
  db: DB;
  providerRegistry: ProviderRegistry;
  workingDirectory?: string;
}): Promise<Hono> {
  const workingDirectory = opts.workingDirectory ?? process.cwd();
  const config = await loadConfig(workingDirectory);
  const toolRegistry = createDefaultRegistry();

  return createApp({
    db: opts.db,
    config,
    providerRegistry: opts.providerRegistry,
    toolRegistry,
    workingDirectory,
  });
}

export default createApp;
