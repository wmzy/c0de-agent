// Anti-pattern detection (inspired by Oh-My-OpenAgent).
//
// Tracks tool call history per runAgent invocation to detect:
//   - Repeated tool calls: same tool + args executed 3+ consecutive times
//   - Excessive tool calls: total tool calls exceeding MAX_TOOL_CALLS_PER_TURN
//   - Short LLM responses: final text response under MIN_LLM_RESPONSE_LENGTH
//     chars when the LLM did not issue any tool calls (likely stuck)
//
// Violations yield a warning AgentEvent. Critical violations (excessive calls,
// repeated calls) cause the agent to stop gracefully.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPEATED_CALL_THRESHOLD = 3;
const MIN_LLM_RESPONSE_LENGTH = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolCallEntry = { name: string; args: string };

type AntiPatternState = {
  recentToolCalls: ToolCallEntry[];
  toolCallsInTurn: number;
};

export type AntiPatternViolation =
  | {
      type: "repeated_tool_calls";
      tool: string;
      count: number;
      message: string;
      severity: "warning" | "critical";
    }
  | {
      type: "excessive_tool_calls";
      total: number;
      limit: number;
      message: string;
      severity: "critical";
    }
  | {
      type: "short_llm_response";
      length: number;
      message: string;
      severity: "warning";
    };

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh anti-pattern detection state for a single runAgent invocation.
 */
export function createAntiPatternState(): AntiPatternState {
  return { recentToolCalls: [], toolCallsInTurn: 0 };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Record a tool call in the recent-history ring buffer.
 * Keeps at most REPEATED_CALL_THRESHOLD entries.
 */
export function recordToolCallEntry(
  state: AntiPatternState,
  name: string,
  args: string,
): void {
  state.recentToolCalls.push({ name, args });
  if (state.recentToolCalls.length > REPEATED_CALL_THRESHOLD) {
    state.recentToolCalls.shift();
  }
  state.toolCallsInTurn++;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/**
 * Detect if the most recent tool calls are identical (same tool + args,
 * repeated REPEATED_CALL_THRESHOLD times consecutively).
 */
export function detectRepeatedToolCalls(
  state: AntiPatternState,
): AntiPatternViolation | null {
  const { recentToolCalls } = state;
  if (recentToolCalls.length < REPEATED_CALL_THRESHOLD) return null;

  const last = recentToolCalls[recentToolCalls.length - 1];
  const allSame = recentToolCalls.every(
    (tc) => tc.name === last.name && tc.args === last.args,
  );
  if (!allSame) return null;

  return {
    type: "repeated_tool_calls",
    tool: last.name,
    count: REPEATED_CALL_THRESHOLD,
    message: `Anti-pattern detected: tool "${last.name}" has been called ${REPEATED_CALL_THRESHOLD} times consecutively with identical arguments. The agent may be stuck in a loop. Stopping to prevent resource waste.`,
    severity: "critical",
  };
}

/**
 * Detect if total tool calls in this turn exceed the limit.
 */
export function detectExcessiveToolCalls(
  state: AntiPatternState,
  limit: number,
): AntiPatternViolation | null {
  if (state.toolCallsInTurn <= limit) return null;
  return {
    type: "excessive_tool_calls",
    total: state.toolCallsInTurn,
    limit,
    message: `Anti-pattern detected: ${state.toolCallsInTurn} tool calls in this turn exceed the limit of ${limit}. The agent is likely stuck. Stopping to prevent resource waste.`,
    severity: "critical",
  };
}

/**
 * Detect suspiciously short LLM response when the model did not issue
 * any tool calls (may indicate the model is stuck or produced a
 * degenerate output).
 */
export function detectShortLlmResponse(
  responseText: string,
  hasToolCalls: boolean,
): AntiPatternViolation | null {
  if (hasToolCalls) return null;
  const trimmed = responseText.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length >= MIN_LLM_RESPONSE_LENGTH) return null;
  return {
    type: "short_llm_response",
    length: trimmed.length,
    message: `Anti-pattern detected: LLM response is only ${trimmed.length} characters ("${trimmed}"). The model may be stuck or produced a degenerate output. Consider retrying or switching models.`,
    severity: "warning",
  };
}
