// Serve command — `c0de serve` (design spec §11.3).
//
// Starts the Hono HTTP server on the configured port. Optionally opens a
// browser pointing to the server URL.
//
// Data + functions: no class, no this, no enum.

import { serve as honoServe } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "../../core/config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServeOptions = {
  port?: number;
  host?: string;
  open?: boolean;
};

// ---------------------------------------------------------------------------
// serve — start the HTTP server
// ---------------------------------------------------------------------------

export async function serve(opts: ServeOptions = {}): Promise<void> {
  const config = await loadConfig(process.cwd());

  const port = opts.port ?? 3000;
  const host = opts.host ?? "0.0.0.0";

  const app = new Hono();

  // Health check
  app.get("/health", (c) => {
    return c.json({ status: "ok", timestamp: Date.now() });
  });

  // Placeholder: chat API — will be implemented by the server package
  app.post("/api/chat", async (c) => {
    const body = await c.req.json();
    return c.json({
      message: "Chat API placeholder. Server package implementation pending.",
      received: body,
    });
  });

  // Placeholder: session API — will be implemented by the server package
  app.get("/api/sessions", (c) => {
    return c.json({ sessions: [] });
  });

  console.log(`c0de server listening on http://${host}:${port}`);

  honoServe({
    fetch: app.fetch,
    port,
    hostname: host,
  });

  if (opts.open) {
    const url = `http://localhost:${port}`;
    // Dynamic import to avoid dependency on node:child_process when not
    // opening a browser.
    const { openBrowser } = await import("../utils/print");
    await openBrowser(url);
  }
}
