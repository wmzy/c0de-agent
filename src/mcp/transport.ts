// MCP transport layer (spec §6).
//
// Implements two transport mechanisms:
//   - stdio: spawns a child process, communicates via stdin/stdout with
//     newline-delimited JSON-RPC 2.0 messages.
//   - SSE: connects to an HTTP Server-Sent Events endpoint, sends messages
//     via HTTP POST.
//
// Each transport factory returns an MCPTransport object with three fields:
//   send(message)   — write a JSON string to the server
//   receive()       — async iterable of JSON strings from the server
//   close()         — tear down the transport
//
// Conventions: data + functions, no class.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { MCPServerConfig, MCPTransport } from "./types";

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

type StdioState = {
  process: ChildProcess;
  lineBuffer: string;
  listeners: Set<(chunk: string) => void>;
  closed: boolean;
};

/**
 * Create a transport that communicates with an MCP server over stdio.
 * Spawns the configured command as a child process. Each JSON-RPC message is
 * a single line (newline-delimited) on stdin/stdout.
 */
export function createStdioTransport(config: MCPServerConfig): MCPTransport {
  if (!config.command) {
    throw new Error(
      `stdio transport requires 'command' in MCPServerConfig (server: ${config.name})`,
    );
  }

  const proc = spawn(config.command, config.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...config.env },
  });

  const state: StdioState = {
    process: proc,
    lineBuffer: "",
    listeners: new Set(),
    closed: false,
  };

  // Accumulate stdout data and emit complete lines to listeners
  proc.stdout?.on("data", (data: Buffer) => {
    state.lineBuffer += data.toString();
    let newlineIdx: number;
    while ((newlineIdx = state.lineBuffer.indexOf("\n")) !== -1) {
      const line = state.lineBuffer.slice(0, newlineIdx).trim();
      state.lineBuffer = state.lineBuffer.slice(newlineIdx + 1);
      if (line.length > 0) {
        state.listeners.forEach((listener) => listener(line));
      }
    }
  });

  proc.stderr?.on("data", (_data: Buffer) => {
    // Stderr from MCP servers is often debug output; we intentionally
    // discard it. A production implementation could log to a file.
  });

  proc.on("close", () => {
    state.closed = true;
    // Emit sentinel to unblock any pending receive() iterator
    state.listeners.forEach((listener) => listener(""));
  });

  return {
    async send(message: string): Promise<void> {
      if (state.closed) {
        throw new Error("stdio transport: cannot send on closed connection");
      }
      return new Promise<void>((resolve, reject) => {
        const ok = proc.stdin?.write(message + "\n");
        if (ok) {
          resolve();
        } else {
          proc.stdin?.once("drain", resolve);
          proc.stdin?.once("error", reject);
        }
      });
    },

    receive(): AsyncIterable<string> {
      return {
        [Symbol.asyncIterator]() {
          const queue: string[] = [];
          let resolve: ((value: IteratorResult<string>) => void) | null = null;
          let done = false;

          const listener = (line: string) => {
            if (line === "" && state.closed) {
              done = true;
              if (resolve) {
                resolve({ value: "", done: true });
                resolve = null;
              }
              return;
            }
            if (line.length > 0) {
              if (resolve) {
                resolve({ value: line, done: false });
                resolve = null;
              } else {
                queue.push(line);
              }
            }
          };

          state.listeners.add(listener);

          return {
            next(): Promise<IteratorResult<string>> {
              if (queue.length > 0) {
                return Promise.resolve({
                  value: queue.shift()!,
                  done: false,
                });
              }
              if (done) {
                return Promise.resolve({ value: "", done: true });
              }
              return new Promise<IteratorResult<string>>((r) => {
                resolve = r;
              });
            },
            return(): Promise<IteratorResult<string>> {
              state.listeners.delete(listener);
              return Promise.resolve({ value: "", done: true });
            },
          };
        },
      };
    },

    close(): void {
      if (!state.closed) {
        state.closed = true;
        proc.kill("SIGTERM");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// SSE transport
// ---------------------------------------------------------------------------

type SSEState = {
  url: string;
  eventSource: EventSource | null;
  listeners: Set<(data: string) => void>;
  closed: boolean;
  postEndpoint: string | null;
};

/**
 * Create a transport that communicates with an MCP server over HTTP SSE.
 * The server exposes an SSE endpoint for receiving messages and an HTTP POST
 * endpoint for sending messages. The POST endpoint is discovered from the
 * SSE stream's first "endpoint" event.
 */
export function createSSETransport(url: string): MCPTransport {
  const state: SSEState = {
    url,
    eventSource: null,
    listeners: new Set(),
    closed: false,
    postEndpoint: null,
  };

  return {
    async send(message: string): Promise<void> {
      if (state.closed) {
        throw new Error("SSE transport: cannot send on closed connection");
      }

      const endpoint = state.postEndpoint ?? state.url;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: message,
      });

      if (!response.ok) {
        throw new Error(`SSE transport: POST failed with status ${response.status}`);
      }
    },

    receive(): AsyncIterable<string> {
      return {
        [Symbol.asyncIterator]() {
          const queue: string[] = [];
          let resolve: ((value: IteratorResult<string>) => void) | null = null;
          let done = false;

          // Connect SSE if not already connected
          if (!state.eventSource && typeof EventSource !== "undefined") {
            const es = new EventSource(state.url);
            state.eventSource = es;

            es.addEventListener("endpoint", (event: MessageEvent) => {
              // The server tells us where to POST messages
              state.postEndpoint = (event.data as string).trim();
            });

            es.addEventListener("message", (event: MessageEvent) => {
              const data = event.data as string;
              if (resolve) {
                resolve({ value: data, done: false });
                resolve = null;
              } else {
                queue.push(data);
              }
            });

            es.onerror = () => {
              if (!state.closed) {
                done = true;
                if (resolve) {
                  resolve({ value: "", done: true });
                  resolve = null;
                }
              }
            };
          }

          return {
            next(): Promise<IteratorResult<string>> {
              if (queue.length > 0) {
                return Promise.resolve({
                  value: queue.shift()!,
                  done: false,
                });
              }
              if (done) {
                return Promise.resolve({ value: "", done: true });
              }
              return new Promise<IteratorResult<string>>((r) => {
                resolve = r;
              });
            },
            return(): Promise<IteratorResult<string>> {
              done = true;
              if (state.eventSource) {
                state.eventSource.close();
                state.eventSource = null;
              }
              return Promise.resolve({ value: "", done: true });
            },
          };
        },
      };
    },

    close(): void {
      state.closed = true;
      if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory — dispatch on config.transport
// ---------------------------------------------------------------------------

/**
 * Create the appropriate transport for the given server configuration.
 */
export function createTransport(config: MCPServerConfig): MCPTransport {
  switch (config.transport) {
    case "stdio":
      return createStdioTransport(config);
    case "sse":
    case "http":
      if (!config.url) {
        throw new Error(
          `${config.transport} transport requires 'url' in MCPServerConfig (server: ${config.name})`,
        );
      }
      return createSSETransport(config.url);
  }
}
