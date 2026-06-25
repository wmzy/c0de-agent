// DAP (Debug Adapter Protocol) integration (§21).
//
// Provides tools for controlling debug sessions through the Debug Adapter
// Protocol. Supports starting, stepping through, and inspecting programs.
//
// Each debug_* tool operates on a named session identified by its adapter
// name and program path — or, for `debug_start`, creates a new session.
//
// The adapter receives JSON-RPC 2.0 messages via stdin and sends responses
// on stdout using the standard DAP length-prefixed transport:
//   Content-Length: <N>\r\n\r\n<JSON body of N bytes>
//
// Conventions: data + functions, no class, no this.

import { type ChildProcess, spawn } from "node:child_process";
import { ok, err, type ToolContext, type ToolDef, type ToolResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DAPSessionState = "running" | "paused" | "stopped";

export type DAPSession = {
  adapter: string;
  program: string;
  state: DAPSessionState;
};

type DAPBreakpoint = {
  file: string;
  line: number;
  condition?: string;
};

type DAPStackFrame = {
  id: number;
  name: string;
  file: string;
  line: number;
  column: number;
};

type DAPVariable = {
  name: string;
  value: string;
  type: string;
  variablesReference: number;
};

// ---------------------------------------------------------------------------
// Session state (module-level, one entry per active session)
// ---------------------------------------------------------------------------

type DAPRuntimeState = {
  session: DAPSession; // public metadata
  process: ChildProcess; // spawned adapter process
  requestSeq: number; // monotonically increasing request id
  pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  buffer: string; // partial response accumulator
  initialized: boolean; // true after initialize response
};

const SESSIONS = new Map<string, DAPRuntimeState>();

// ---------------------------------------------------------------------------
// DAP transport — JSON-RPC 2.0 over length-prefixed stdin/stdout
// ---------------------------------------------------------------------------

/**
 * Build a session key from adapter + program.
 */
function sessionKey(adapter: string, program: string): string {
  return `${adapter}::${program}`;
}

/**
 * Send a JSON-RPC request to the debug adapter and await its response.
 * Automatically increments the sequence number.
 */
function sendRequest(
  state: DAPRuntimeState,
  command: string,
  params: Record<string, unknown> | undefined,
): Promise<unknown> {
  const seq = ++state.requestSeq;

  const body = JSON.stringify({
    seq,
    type: "request",
    command,
    arguments: params,
  });

  return new Promise((resolve, reject) => {
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    state.pendingRequests.set(seq, { resolve, reject });

    if (!state.process.stdin || state.process.stdin.destroyed) {
      state.pendingRequests.delete(seq);
      reject(new Error("debug adapter stdin is closed"));
      return;
    }

    state.process.stdin.write(header + body, "utf8");
  });
}

/**
 * Parse a DAP response body. DAP uses its own JSON-RPC variant:
 *   - Responses have: seq, type: "response", request_seq, command, success, body, message
 *   - Events have: seq, type: "event", event, body
 */
function parseDAPResponseBody(
  raw: string,
): { seq: number; type: string } & Record<string, unknown> {
  return JSON.parse(raw) as { seq: number; type: string } & Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Raw DAP operations (low-level)
// ---------------------------------------------------------------------------

/**
 * Perform the DAP handshake: send Initialize, wait for Initialized event,
 * then send Launch/Attach and ConfigurationDone.
 */
async function dapInitialize(
  state: DAPRuntimeState,
  launchArgs: Record<string, unknown> | undefined,
): Promise<void> {
  const initResp = await sendRequest(state, "initialize", {
    clientID: "c0de-agent",
    clientName: "c0de-agent DAP Client",
    adapterID: state.session.adapter,
    supportsRunInTerminalRequest: false,
    supportsVariableType: true,
    supportsMemoryReferences: false,
  });

  const init = initResp as Record<string, unknown>;
  if (!init.success) {
    throw new Error(
      `DAP initialize failed: ${(init.message as string) ?? JSON.stringify(init.body)}`,
    );
  }

  state.initialized = true;

  // Wait for 'initialized' event (the adapter sends it after receiving initialize)
  // Then send launch + configurationDone
  if (launchArgs) {
    await sendRequest(state, "launch", launchArgs);
  }
  await sendRequest(state, "configurationDone", undefined);
}

/**
 * Set a breakpoint (returns the DAP breakpoint response).
 */
async function dapSetBreakpoint(state: DAPRuntimeState, bp: DAPBreakpoint): Promise<unknown> {
  return await sendRequest(state, "setBreakpoint", {
    source: { path: bp.file },
    line: bp.line,
    condition: bp.condition ?? undefined,
  });
}

/**
 * Resume execution.
 */
async function dapContinue(state: DAPRuntimeState): Promise<unknown> {
  return await sendRequest(state, "continue", { threadId: 1 });
}

/**
 * Step over (next), step in, or step out.
 */
async function dapStep(
  state: DAPRuntimeState,
  action: "next" | "stepIn" | "stepOut",
): Promise<unknown> {
  const command = action === "next" ? "next" : action === "stepIn" ? "stepIn" : "stepOut";
  return await sendRequest(state, command, { threadId: 1 });
}

/**
 * Get stack trace.
 */
async function dapStackTrace(state: DAPRuntimeState): Promise<unknown> {
  return await sendRequest(state, "stackTrace", {
    threadId: 1,
    startFrame: 0,
    levels: 50,
  });
}

/**
 * Get variables for a given variablesReference.
 */
async function dapVariables(state: DAPRuntimeState, variablesReference: number): Promise<unknown> {
  return await sendRequest(state, "variables", {
    variablesReference,
  });
}

/**
 * Evaluate an expression in the context of the top stack frame.
 */
async function dapEvaluate(
  state: DAPRuntimeState,
  expression: string,
  frameId?: number,
): Promise<unknown> {
  return await sendRequest(state, "evaluate", {
    expression,
    frameId: frameId ?? 1,
    context: "repl",
  });
}

/**
 * Terminate and disconnect.
 */
async function dapDisconnect(state: DAPRuntimeState): Promise<void> {
  try {
    await sendRequest(state, "terminate", { restart: false });
  } catch {
    // ignore — adapter may already be gone
  }
  try {
    await sendRequest(state, "disconnect", { restart: false, terminateDebuggee: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Spawn the debug adapter and set up the JSON-RPC transport.
 */
function spawnAdapter(adapter: string, program: string): Promise<DAPRuntimeState> {
  return new Promise((resolve, reject) => {
    // Determine the adapter command based on the language/adapter name
    const cmd = resolveAdapterCommand(adapter);

    if (!cmd) {
      reject(new Error(`Unknown debug adapter: "${adapter}". Supported: node, python, chrome`));
      return;
    }

    const proc = spawn(cmd.command, cmd.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const state: DAPRuntimeState = {
      session: { adapter, program, state: "running" },
      process: proc,
      requestSeq: 0,
      pendingRequests: new Map(),
      buffer: "",
      initialized: false,
    };

    // Track response data
    proc.stdout?.on("data", (chunk: Buffer) => {
      state.buffer += chunk.toString("utf8");
      processBuffer(state);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      // Some adapters log diagnostics to stderr — ignore by default
    });

    proc.on("error", (error: Error) => {
      rejectAllPending(state, new Error(`adapter process error: ${error.message}`));
      reject(error);
    });

    proc.on("exit", (code: number | null) => {
      // Reject any pending requests
      rejectAllPending(state, new Error(`adapter exited with code ${code ?? "signal"}`));
    });

    // Give the adapter a moment to start, then resolve
    // Actually we should wait for the initialize response, but that's handled
    // by dapInitialize which is called from debug_start's execute.
    // For now just resolve with the state.
    resolve(state);
  });
}

/**
 * Resolve a debug adapter name to a command + args.
 */
function resolveAdapterCommand(adapter: string): { command: string; args?: string[] } | null {
  switch (adapter) {
    case "node":
    case "node2":
      return { command: "node", args: ["--inspect-brk"] };
    case "python":
      return { command: "python", args: ["-m", "debugpy.adapter"] };
    case "chrome":
      return { command: "node", args: [] }; // Placeholder — real Chrome DAP is more complex
    default:
      // Try as a direct executable path
      return { command: adapter };
  }
}

/**
 * Reject all pending requests with a given error.
 */
function rejectAllPending(state: DAPRuntimeState, error: Error): void {
  state.pendingRequests.forEach((pending, seq) => {
    pending.reject(error);
    state.pendingRequests.delete(seq);
  });
}

/**
 * Process incoming DAP data buffer — extract complete messages
 * from the length-prefixed protocol stream.
 */
function processBuffer(state: DAPRuntimeState): void {
  const CRLF = "\r\n";
  let idx: number;

  while ((idx = state.buffer.indexOf(CRLF)) !== -1) {
    const headerLine = state.buffer.slice(0, idx);

    // Headers end with an empty line (double CRLF)
    const doubleCRLF = state.buffer.indexOf(`${CRLF}${CRLF}`);
    if (doubleCRLF === -1) break;

    const headers = state.buffer.slice(0, doubleCRLF);
    const contentStart = doubleCRLF + 4; // after \r\n\r\n

    // Parse Content-Length
    const contentLengthMatch = headers.match(/Content-Length:\s*(\d+)/i);
    if (!contentLengthMatch) {
      // Malformed — skip the first line
      state.buffer = state.buffer.slice(idx + 2);
      continue;
    }

    const contentLength = Number.parseInt(contentLengthMatch[1], 10);
    const remainingBody = state.buffer.slice(contentStart);

    if (remainingBody.length < contentLength) {
      // Wait for more data
      break;
    }

    const body = remainingBody.slice(0, contentLength);
    state.buffer = remainingBody.slice(contentLength);

    try {
      handleMessage(state, body);
    } catch (error) {
      // If we can't parse a message, log and move on
      console.error("DAP parse error:", (error as Error).message);
    }
  }
}

/**
 * Handle a single DAP message (response or event).
 */
function handleMessage(state: DAPRuntimeState, rawBody: string): void {
  const msg = parseDAPResponseBody(rawBody);

  if (msg.type === "response") {
    const response = msg as Record<string, unknown>;
    const requestSeq = response.request_seq as number;
    const pending = state.pendingRequests.get(requestSeq);
    if (pending) {
      state.pendingRequests.delete(requestSeq);
      if (response.success) {
        pending.resolve(response);
      } else {
        pending.reject(
          new Error(
            `DAP error: ${(response.message as string) ?? "unknown error"} — ${JSON.stringify(response.body)}`,
          ),
        );
      }
    }
  } else if (msg.type === "event") {
    const event = msg as Record<string, unknown>;
    const eventType = event.event as string;

    switch (eventType) {
      case "stopped":
        state.session.state = "paused";
        break;
      case "continued":
        state.session.state = "running";
        break;
      case "exited":
      case "terminated":
        state.session.state = "stopped";
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Tool: debug_start
// ---------------------------------------------------------------------------

export const debugStartTool: ToolDef = {
  name: "debug_start",
  description:
    "Start a new DAP debug session. Spawns the specified debug adapter and initializes " +
    "the session. Supports 'node' (Node.js) and 'python' (Python via debugpy) adapters. " +
    "Pass optional launchArgs as a JSON string for adapter-specific configurations.",
  parameters: {
    type: "object",
    properties: {
      adapter: {
        type: "string",
        description:
          'Debug adapter name. Supported: "node" (Node.js --inspect-brk), "python" (debugpy), "chrome".',
      },
      program: {
        type: "string",
        description: "Path to the program to debug.",
      },
      launchArgs: {
        type: "string",
        description:
          "Optional JSON string with additional launch arguments for the adapter " +
          '(e.g. \'{"type":"node","request":"launch","name":"Debug","runtimeArgs":["--harmony"]}\').',
      },
    },
    required: ["adapter", "program"],
    additionalProperties: false,
  },
  permission: "ask",

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;
    const adapter = typeof args.adapter === "string" ? args.adapter.trim() : "";
    const program = typeof args.program === "string" ? args.program.trim() : "";

    if (adapter.length === 0) {
      return err('debug_start: "adapter" argument is required (node, python, chrome)');
    }
    if (program.length === 0) {
      return err('debug_start: "program" argument is required');
    }

    const key = sessionKey(adapter, program);

    // If session already exists, return it
    const existing = SESSIONS.get(key);
    if (existing) {
      return ok(
        `Debug session already running for ${adapter}:${program} (state: ${existing.session.state})`,
        { session: existing.session },
      );
    }

    try {
      const state = await spawnAdapter(adapter, program);

      // Resolve program relative to cwd if not absolute
      const resolvedProgram = program.startsWith("/") ? program : `${context.cwd}/${program}`;

      // Parse optional launchArgs
      let parsedLaunchArgs: Record<string, unknown> | undefined;
      if (typeof args.launchArgs === "string" && args.launchArgs.length > 0) {
        try {
          parsedLaunchArgs = JSON.parse(args.launchArgs) as Record<string, unknown>;
        } catch {
          return err(`debug_start: invalid JSON in launchArgs: ${args.launchArgs}`);
        }
      }

      // Build standard launch arguments
      const launchArgs: Record<string, unknown> = parsedLaunchArgs ?? {
        type: adapter,
        request: "launch",
        name: `Debug ${program}`,
        program: resolvedProgram,
        stopOnEntry: false,
        cwd: context.cwd,
      };

      // Initialize handshake
      await dapInitialize(state, launchArgs);

      SESSIONS.set(key, state);

      return ok(
        `Debug session started: ${adapter}:${program}\nState: ${state.session.state}\nPID: ${state.process.pid}`,
        { session: state.session },
      );
    } catch (error) {
      // Clean up on failure
      const failed = SESSIONS.get(key);
      if (failed) {
        cleanupSession(key, failed);
      }
      return err(`debug_start: ${(error as Error).message}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: debug_breakpoint
// ---------------------------------------------------------------------------

export const debugBreakpointTool: ToolDef = {
  name: "debug_breakpoint",
  description: "Set a breakpoint in the active debug session.",
  parameters: {
    type: "object",
    properties: {
      adapter: {
        type: "string",
        description: "Debug adapter name matching the active session.",
      },
      program: {
        type: "string",
        description: "Program path matching the active session.",
      },
      file: {
        type: "string",
        description: "File path to set the breakpoint in.",
      },
      line: {
        type: "integer",
        description: "Line number (1-indexed) to set the breakpoint on.",
        minimum: 1,
      },
      condition: {
        type: "string",
        description: "Optional breakpoint condition expression.",
      },
    },
    required: ["adapter", "program", "file", "line"],
    additionalProperties: false,
  },
  permission: "auto",

  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;

    const adapter = typeof args.adapter === "string" ? args.adapter.trim() : "";
    const program = typeof args.program === "string" ? args.program.trim() : "";
    const file = typeof args.file === "string" ? args.file.trim() : "";
    const line = typeof args.line === "number" ? Math.floor(args.line) : 0;
    const condition = typeof args.condition === "string" ? args.condition.trim() : undefined;

    if (!adapter || !program || !file || line < 1) {
      return err('debug_breakpoint: requires "adapter", "program", "file", and "line" arguments');
    }

    const key = sessionKey(adapter, program);
    const state = SESSIONS.get(key);

    if (!state) {
      return err(
        `debug_breakpoint: no active session for ${adapter}:${program}. Start one with debug_start.`,
      );
    }

    try {
      const response = (await dapSetBreakpoint(state, {
        file,
        line,
        condition,
      })) as Record<string, unknown>;

      const body = response.body as Record<string, unknown> | undefined;
      const bp = body?.breakpoints as Array<Record<string, unknown>> | undefined;

      if (bp && bp.length > 0) {
        return ok(`Breakpoint set at ${file}:${line}`, { breakpoints: bp });
      }

      return ok(`Breakpoint set at ${file}:${line}`);
    } catch (error) {
      return err(`debug_breakpoint: ${(error as Error).message}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: debug_continue
// ---------------------------------------------------------------------------

export const debugContinueTool: ToolDef = {
  name: "debug_continue",
  description: "Resume execution in the active debug session.",
  parameters: {
    type: "object",
    properties: {
      adapter: {
        type: "string",
        description: "Debug adapter name matching the active session.",
      },
      program: {
        type: "string",
        description: "Program path matching the active session.",
      },
    },
    required: ["adapter", "program"],
    additionalProperties: false,
  },
  permission: "auto",

  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;

    const adapter = typeof args.adapter === "string" ? args.adapter.trim() : "";
    const program = typeof args.program === "string" ? args.program.trim() : "";

    if (!adapter || !program) {
      return err('debug_continue: requires "adapter" and "program" arguments');
    }

    const key = sessionKey(adapter, program);
    const state = SESSIONS.get(key);

    if (!state) {
      return err(
        `debug_continue: no active session for ${adapter}:${program}. Start one with debug_start.`,
      );
    }

    try {
      const response = (await dapContinue(state)) as Record<string, unknown>;
      state.session.state = "running";

      return ok("Execution resumed", { state: state.session.state });
    } catch (error) {
      return err(`debug_continue: ${(error as Error).message}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: debug_step
// ---------------------------------------------------------------------------

export const debugStepTool: ToolDef = {
  name: "debug_step",
  description:
    "Step through code in the active debug session. Supports 'over' (next line), " +
    "'in' (step into function), and 'out' (step out of function).",
  parameters: {
    type: "object",
    properties: {
      adapter: {
        type: "string",
        description: "Debug adapter name matching the active session.",
      },
      program: {
        type: "string",
        description: "Program path matching the active session.",
      },
      action: {
        type: "string",
        description: 'Step action: "over", "in", or "out". Default: "over".',
        enum: ["over", "in", "out"],
        default: "over",
      },
    },
    required: ["adapter", "program"],
    additionalProperties: false,
  },
  permission: "auto",

  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;

    const adapter = typeof args.adapter === "string" ? args.adapter.trim() : "";
    const program = typeof args.program === "string" ? args.program.trim() : "";
    const action = typeof args.action === "string" ? args.action.trim() : "over";

    if (!adapter || !program) {
      return err('debug_step: requires "adapter" and "program" arguments');
    }

    const key = sessionKey(adapter, program);
    const state = SESSIONS.get(key);

    if (!state) {
      return err(
        `debug_step: no active session for ${adapter}:${program}. Start one with debug_start.`,
      );
    }

    const dapAction =
      action === "in"
        ? ("stepIn" as const)
        : action === "out"
          ? ("stepOut" as const)
          : ("next" as const);

    try {
      await dapStep(state, dapAction);

      // Give the adapter a moment to send the stopped event, then fetch stack
      // The state will be updated by the event handler

      return ok(`Stepped ${action}`, { action, state: state.session.state });
    } catch (error) {
      return err(`debug_step: ${(error as Error).message}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: debug_stack
// ---------------------------------------------------------------------------

export const debugStackTool: ToolDef = {
  name: "debug_stack",
  description: "Retrieve the call stack from the active debug session.",
  parameters: {
    type: "object",
    properties: {
      adapter: {
        type: "string",
        description: "Debug adapter name matching the active session.",
      },
      program: {
        type: "string",
        description: "Program path matching the active session.",
      },
    },
    required: ["adapter", "program"],
    additionalProperties: false,
  },
  permission: "auto",

  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;

    const adapter = typeof args.adapter === "string" ? args.adapter.trim() : "";
    const program = typeof args.program === "string" ? args.program.trim() : "";

    if (!adapter || !program) {
      return err('debug_stack: requires "adapter" and "program" arguments');
    }

    const key = sessionKey(adapter, program);
    const state = SESSIONS.get(key);

    if (!state) {
      return err(
        `debug_stack: no active session for ${adapter}:${program}. Start one with debug_start.`,
      );
    }

    try {
      const response = (await dapStackTrace(state)) as Record<string, unknown>;
      const body = response.body as Record<string, unknown> | undefined;
      const stackFrames = body?.stackFrames as Array<Record<string, unknown>> | undefined;

      if (!stackFrames || stackFrames.length === 0) {
        return ok("(empty call stack)");
      }

      const frames: DAPStackFrame[] = stackFrames.map((f) => ({
        id: f.id as number,
        name: f.name as string,
        file: ((f.source as Record<string, unknown>)?.path as string) ?? "<unknown>",
        line: f.line as number,
        column: f.column as number,
      }));

      const output = frames
        .map((f, i) => `  #${i} ${f.name} at ${f.file}:${f.line}:${f.column}`)
        .join("\n");

      return ok(output, { stackFrames: frames });
    } catch (error) {
      return err(`debug_stack: ${(error as Error).message}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: debug_vars
// ---------------------------------------------------------------------------

export const debugVarsTool: ToolDef = {
  name: "debug_vars",
  description:
    "Retrieve local variables from the top stack frame of the active debug session. " +
    "Optionally pass a frameId to inspect a specific frame, or variablesReference to " +
    "expand nested variables.",
  parameters: {
    type: "object",
    properties: {
      adapter: {
        type: "string",
        description: "Debug adapter name matching the active session.",
      },
      program: {
        type: "string",
        description: "Program path matching the active session.",
      },
      frameId: {
        type: "integer",
        description: "Optional stack frame ID to inspect. Defaults to top frame (0).",
        minimum: 0,
      },
      variablesReference: {
        type: "integer",
        description:
          "Optional variablesReference to expand nested variables (e.g. from a previous vars call).",
        minimum: 0,
      },
    },
    required: ["adapter", "program"],
    additionalProperties: false,
  },
  permission: "auto",

  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;

    const adapter = typeof args.adapter === "string" ? args.adapter.trim() : "";
    const program = typeof args.program === "string" ? args.program.trim() : "";
    const frameId = typeof args.frameId === "number" ? args.frameId : undefined;
    const variablesReference =
      typeof args.variablesReference === "number" ? args.variablesReference : undefined;

    if (!adapter || !program) {
      return err('debug_vars: requires "adapter" and "program" arguments');
    }

    const key = sessionKey(adapter, program);
    const state = SESSIONS.get(key);

    if (!state) {
      return err(
        `debug_vars: no active session for ${adapter}:${program}. Start one with debug_start.`,
      );
    }

    try {
      let ref = variablesReference;

      // If no explicit variablesReference, get it from the top stack frame
      if (ref === undefined || ref === 0) {
        const stackResp = (await dapStackTrace(state)) as Record<string, unknown>;
        const body = stackResp.body as Record<string, unknown> | undefined;
        const stackFrames = body?.stackFrames as Array<Record<string, unknown>> | undefined;

        if (!stackFrames || stackFrames.length === 0) {
          return ok("(no stack frames available)");
        }

        // Pick the requested frame (default = 0) or the top frame
        const targetFrame =
          typeof frameId === "number" ? stackFrames.find((f) => f.id === frameId) : stackFrames[0];

        if (!targetFrame) {
          return ok(`(frame ${frameId} not found)`);
        }

        ref = targetFrame.id as number;
      }

      const varsResp = (await dapVariables(state, ref)) as Record<string, unknown>;
      const varsBody = varsResp.body as Record<string, unknown> | undefined;
      const variables = varsBody?.variables as Array<Record<string, unknown>> | undefined;

      if (!variables || variables.length === 0) {
        return ok("(no variables)");
      }

      const formatted = variables
        .map((v) => {
          const name = v.name as string;
          const value = v.value as string;
          const typeInfo = v.type as string | undefined;
          const varRef = v.variablesReference as number;
          const typeStr = typeInfo ? ` (${typeInfo})` : "";
          const expandable = varRef && varRef > 0 ? " [expandable]" : "";
          return `  ${name} = ${value}${typeStr}${expandable}`;
        })
        .join("\n");

      return ok(formatted, { variables });
    } catch (error) {
      return err(`debug_vars: ${(error as Error).message}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: debug_eval
// ---------------------------------------------------------------------------

export const debugEvalTool: ToolDef = {
  name: "debug_eval",
  description: "Evaluate an expression in the context of the active debug session.",
  parameters: {
    type: "object",
    properties: {
      adapter: {
        type: "string",
        description: "Debug adapter name matching the active session.",
      },
      program: {
        type: "string",
        description: "Program path matching the active session.",
      },
      expression: {
        type: "string",
        description: "Expression to evaluate in the debug context.",
      },
      frameId: {
        type: "integer",
        description: "Optional stack frame ID to evaluate in. Defaults to top frame.",
        minimum: 0,
      },
    },
    required: ["adapter", "program", "expression"],
    additionalProperties: false,
  },
  permission: "auto",

  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;

    const adapter = typeof args.adapter === "string" ? args.adapter.trim() : "";
    const program = typeof args.program === "string" ? args.program.trim() : "";
    const expression = typeof args.expression === "string" ? args.expression.trim() : "";
    const frameId = typeof args.frameId === "number" ? args.frameId : undefined;

    if (!adapter || !program) {
      return err('debug_eval: requires "adapter" and "program" arguments');
    }
    if (expression.length === 0) {
      return err('debug_eval: "expression" argument is required');
    }

    const key = sessionKey(adapter, program);
    const state = SESSIONS.get(key);

    if (!state) {
      return err(
        `debug_eval: no active session for ${adapter}:${program}. Start one with debug_start.`,
      );
    }

    try {
      const response = (await dapEvaluate(state, expression, frameId)) as Record<string, unknown>;
      const body = response.body as Record<string, unknown> | undefined;
      const result = (body?.result as string) ?? "(no result)";

      return ok(`> ${expression}\n= ${result}`, { expression, result });
    } catch (error) {
      return err(`debug_eval: ${(error as Error).message}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: debug_stop
// ---------------------------------------------------------------------------

export const debugStopTool: ToolDef = {
  name: "debug_stop",
  description: "Stop the active debug session and terminate the debugged program.",
  parameters: {
    type: "object",
    properties: {
      adapter: {
        type: "string",
        description: "Debug adapter name matching the active session.",
      },
      program: {
        type: "string",
        description: "Program path matching the active session.",
      },
    },
    required: ["adapter", "program"],
    additionalProperties: false,
  },
  permission: "auto",

  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;

    const adapter = typeof args.adapter === "string" ? args.adapter.trim() : "";
    const program = typeof args.program === "string" ? args.program.trim() : "";

    if (!adapter || !program) {
      return err('debug_stop: requires "adapter" and "program" arguments');
    }

    const key = sessionKey(adapter, program);
    const state = SESSIONS.get(key);

    if (!state) {
      return ok(`No active session for ${adapter}:${program} — nothing to stop`);
    }

    try {
      await dapDisconnect(state);
    } catch {
      // best-effort disconnect
    }

    cleanupSession(key, state);

    return ok(`Debug session stopped: ${adapter}:${program}`);
  },
};

// ---------------------------------------------------------------------------
// Internal cleanup
// ---------------------------------------------------------------------------

function cleanupSession(key: string, state: DAPRuntimeState): void {
  SESSIONS.delete(key);

  // Reject remaining pending requests
  rejectAllPending(state, new Error("debug session stopped"));

  // Kill the process
  if (state.process && !state.process.killed) {
    try {
      state.process.kill("SIGTERM");
      // Force kill after a short timeout
      setTimeout(() => {
        if (!state.process.killed) {
          try {
            state.process.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, 2000).unref();
    } catch {
      // ignore
    }
  }
}
