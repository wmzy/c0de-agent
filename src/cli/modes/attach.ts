// Attach mode — connect to a running `c0de` server and interact with it
// (design spec §11.4).
//
// Opens a WebSocket connection to a running server, sends a user message,
// and streams back agent events. Used by `c0de attach <url>`.
//
// Data + functions: no class, no this, no enum.

import type { WebSocket as WSWebSocket } from "ws";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Connection = {
  url: string;
  ws: WSWebSocket;
};

export type Event = {
  type: string;
  data: unknown;
};

// ---------------------------------------------------------------------------
// connectToServer — open a WebSocket connection to the server
// ---------------------------------------------------------------------------

export async function connectToServer(url: string): Promise<Connection> {
  const wsUrl = url.replace(/^http/, "ws");
  const wsPath = `${wsUrl}/ws`;

  // Dynamic import to keep the WebSocket API available across runtimes.
  const WebSocketModule = await import("ws");
  const WebSocket = WebSocketModule.default as typeof WSWebSocket;

  const ws = new WebSocket(wsPath);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Connection to ${url} timed out`));
    }, 10_000);

    ws.on("open", () => {
      clearTimeout(timeout);
      resolve();
    });

    ws.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return { url, ws };
}

// ---------------------------------------------------------------------------
// sendMessage — send a JSON-RPC chat request over the connection
// ---------------------------------------------------------------------------

export function sendMessage(connection: Connection, message: string): void {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "chat",
    params: { message },
  });

  connection.ws.send(payload);
}

// ---------------------------------------------------------------------------
// receiveEvents — iterate over JSON-RPC event notifications
// ---------------------------------------------------------------------------

export async function* receiveEvents(connection: Connection): AsyncGenerator<Event> {
  const { ws } = connection;

  while (ws.readyState === 1) { // WebSocket.OPEN
    const data = await new Promise<string>((resolve, reject) => {
      ws.once("message", (d: Buffer) => resolve(d.toString()));
      ws.once("error", (err: Error) => reject(err));
      ws.once("close", () => reject(new Error("Connection closed")));
    });

    try {
      const msg = JSON.parse(data);
      if (msg.method === "event" && msg.params) {
        yield msg.params as Event;
      }
    } catch {
      // Non-JSON or malformed — skip
    }
  }
}