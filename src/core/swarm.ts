// Swarm multi-agent orchestration engine (data + functions paradigm).
//
// Inspired by OpenAI's Swarm pattern, adapted for the Oh-My-OpenAgent harness:
//   - Agents are lightweight roles with capabilities, managed as plain data.
//   - Tasks are assigned to agents based on capability matching.
//   - Inter-agent communication uses a simple message queue.
//   - No classes, no this, no enum — pure data types + exported functions.
//
// Design:
//   - SwarmManager is a mutable state bag (same pattern as
//     PreemptiveCompactionState in preemptive-compaction.ts).
//   - SwarmAgent tracks role/capabilities/status via tagged unions.
//   - SwarmTask tracks assignment/execution/result lifecycle.
//   - assignTask dispatches work through a pluggable taskHandler.
//   - sendMessage / getMessages provide simple inter-agent communication.

// ---------------------------------------------------------------------------
// Agent status (discriminated union via `_tag`)
// ---------------------------------------------------------------------------

export type SwarmAgentStatus =
  | { _tag: "idle" }
  | { _tag: "busy"; taskId: string; startedAt: number }
  | { _tag: "offline" }
  | { _tag: "error"; message: string };

// ---------------------------------------------------------------------------
// SwarmAgent — a lightweight agent participant
// ---------------------------------------------------------------------------

export type SwarmAgent = {
  id: string;
  role: string;
  capabilities: string[];
  status: SwarmAgentStatus;
};

// ---------------------------------------------------------------------------
// Task status (discriminated union via `_tag`)
// ---------------------------------------------------------------------------

export type SwarmTaskStatus =
  | { _tag: "pending" }
  | { _tag: "assigned"; agentId: string }
  | { _tag: "running"; agentId: string; startedAt: number }
  | { _tag: "completed"; agentId: string; result: unknown }
  | { _tag: "failed"; agentId: string; error: string }
  | { _tag: "cancelled" };

// ---------------------------------------------------------------------------
// SwarmTask — a unit of work dispatched to the swarm
// ---------------------------------------------------------------------------

export type SwarmTask = {
  id: string;
  agentId?: string;
  prompt: string;
  status: SwarmTaskStatus;
  result?: unknown;
};

// ---------------------------------------------------------------------------
// SwarmMessage — inter-agent communication
// ---------------------------------------------------------------------------

export type SwarmMessage = {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  content: string;
  timestamp: number;
  taskId?: string;
};

// ---------------------------------------------------------------------------
// Task handler — the async function that actually executes a task on an agent.
// Callers provide this at swarm creation time; the default handler is a no-op
// that immediately completes the task with `null`.
// ---------------------------------------------------------------------------

export type SwarmTaskHandler = (
  task: SwarmTask,
  agent: SwarmAgent,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// SwarmManager — the mutable orchestration state
// ---------------------------------------------------------------------------

export type SwarmManager = {
  agents: Map<string, SwarmAgent>;
  tasks: Map<string, SwarmTask>;
  messages: SwarmMessage[];
  taskHandler: SwarmTaskHandler;
};

// ---------------------------------------------------------------------------
// SwarmStatus — read-only summary of swarm health
// ---------------------------------------------------------------------------

export type SwarmStatus = {
  totalAgents: number;
  idleAgents: number;
  busyAgents: number;
  offlineAgents: number;
  errorAgents: number;
  totalTasks: number;
  pendingTasks: number;
  assignedTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  cancelledTasks: number;
  totalMessages: number;
};

// ---------------------------------------------------------------------------
// createSwarm — initialize a swarm from a list of agents
// ---------------------------------------------------------------------------

/**
 * Create a new SwarmManager with the given agents.  Each agent's status is
 * reset to idle.  An optional `taskHandler` controls how tasks are executed;
 * the default handler immediately completes each task with `null`.
 */
export function createSwarm(
  agents: SwarmAgent[],
  opts?: { taskHandler?: SwarmTaskHandler },
): SwarmManager {
  const agentMap = new Map<string, SwarmAgent>();
  for (const agent of agents) {
    agentMap.set(agent.id, {
      ...agent,
      status: { _tag: "idle" },
    });
  }
  return {
    agents: agentMap,
    tasks: new Map(),
    messages: [],
    taskHandler: opts?.taskHandler ?? defaultTaskHandler,
  };
}

// ---------------------------------------------------------------------------
// assignTask — find a suitable agent and dispatch the task
// ---------------------------------------------------------------------------

/**
 * Assign a task to the swarm.  Finds the best available agent by matching
 * capabilities, marks agent as busy, marks task as running, and invokes the
 * task handler.  On completion the agent returns to idle and the task is
 * marked completed or failed.
 *
 * Returns silently if no idle agent is available (task stays pending) or
 * the task id already exists.
 */
export async function assignTask(
  swarm: SwarmManager,
  task: SwarmTask,
): Promise<void> {
  // Guard: duplicate task id
  if (swarm.tasks.has(task.id)) return;

  // Insert task as pending
  const pendingTask: SwarmTask = { ...task, status: { _tag: "pending" } };
  swarm.tasks.set(task.id, pendingTask);

  // Find best idle agent
  const agent = findAgentForTask(swarm, pendingTask);
  if (!agent) return; // stays pending until an agent frees up

  await dispatchToAgent(swarm, agent, pendingTask);
}

// ---------------------------------------------------------------------------
// getSwarmStatus — read-only snapshot of swarm health
// ---------------------------------------------------------------------------

/**
 * Return a snapshot of the swarm's current state: agent counts by status,
 * task counts by status, and total message count.
 */
export function getSwarmStatus(swarm: SwarmManager): SwarmStatus {
  let idleAgents = 0;
  let busyAgents = 0;
  let offlineAgents = 0;
  let errorAgents = 0;

  for (const agent of swarm.agents.values()) {
    switch (agent.status._tag) {
      case "idle":
        idleAgents++;
        break;
      case "busy":
        busyAgents++;
        break;
      case "offline":
        offlineAgents++;
        break;
      case "error":
        errorAgents++;
        break;
    }
  }

  let pendingTasks = 0;
  let assignedTasks = 0;
  let runningTasks = 0;
  let completedTasks = 0;
  let failedTasks = 0;
  let cancelledTasks = 0;

  for (const task of swarm.tasks.values()) {
    switch (task.status._tag) {
      case "pending":
        pendingTasks++;
        break;
      case "assigned":
        assignedTasks++;
        break;
      case "running":
        runningTasks++;
        break;
      case "completed":
        completedTasks++;
        break;
      case "failed":
        failedTasks++;
        break;
      case "cancelled":
        cancelledTasks++;
        break;
    }
  }

  return {
    totalAgents: swarm.agents.size,
    idleAgents,
    busyAgents,
    offlineAgents,
    errorAgents,
    totalTasks: swarm.tasks.size,
    pendingTasks,
    assignedTasks,
    runningTasks,
    completedTasks,
    failedTasks,
    cancelledTasks,
    totalMessages: swarm.messages.length,
  };
}

// ---------------------------------------------------------------------------
// sendMessage — enqueue a message between agents
// ---------------------------------------------------------------------------

/**
 * Send a message from one agent to another.  Returns the created message
 * with its generated id and timestamp.  Does not verify that either agent
 * exists — the caller is responsible for valid ids.
 */
export function sendMessage(
  swarm: SwarmManager,
  msg: Omit<SwarmMessage, "id" | "timestamp">,
): SwarmMessage {
  const message: SwarmMessage = {
    id: generateId("msg"),
    timestamp: Date.now(),
    ...msg,
  };
  swarm.messages.push(message);
  return message;
}

// ---------------------------------------------------------------------------
// getMessages — retrieve messages for an agent
// ---------------------------------------------------------------------------

/**
 * Return all messages addressed to the given agent, optionally filtered
 * to a specific task.
 */
export function getMessages(
  swarm: SwarmManager,
  agentId: string,
  opts?: { taskId?: string },
): SwarmMessage[] {
  return swarm.messages.filter(
    (m) =>
      m.toAgentId === agentId &&
      (opts?.taskId === undefined || m.taskId === opts.taskId),
  );
}

// ---------------------------------------------------------------------------
// getAgentTasks — tasks assigned to a specific agent
// ---------------------------------------------------------------------------

/**
 * Return all tasks currently assigned to or completed by the given agent.
 */
export function getAgentTasks(
  swarm: SwarmManager,
  agentId: string,
): SwarmTask[] {
  const result: SwarmTask[] = [];
  for (const task of swarm.tasks.values()) {
    if (task.agentId === agentId) {
      result.push(task);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// retryTask — re-dispatch a failed or pending task
// ---------------------------------------------------------------------------

/**
 * Retry a failed or pending task by resetting it to pending and attempting
 * assignment again.  Returns silently if the task is not in a retryable
 * state or no agent is available.
 */
export async function retryTask(
  swarm: SwarmManager,
  taskId: string,
): Promise<void> {
  const task = swarm.tasks.get(taskId);
  if (!task) return;

  const canRetry =
    task.status._tag === "failed" || task.status._tag === "pending";
  if (!canRetry) return;

  // Reset task to pending
  task.status = { _tag: "pending" };
  task.agentId = undefined;
  task.result = undefined;

  const agent = findAgentForTask(swarm, task);
  if (!agent) return;

  await dispatchToAgent(swarm, agent, task);
}

// ---------------------------------------------------------------------------
// cancelTask — cancel a pending, assigned, or running task
// ---------------------------------------------------------------------------

/**
 * Cancel a task.  If the task is running, the agent is freed.  Returns
 * `true` if the task was cancelled, `false` if it was already terminal.
 */
export function cancelTask(swarm: SwarmManager, taskId: string): boolean {
  const task = swarm.tasks.get(taskId);
  if (!task) return false;

  // Can't cancel terminal states
  if (
    task.status._tag === "completed" ||
    task.status._tag === "failed" ||
    task.status._tag === "cancelled"
  ) {
    return false;
  }

  // Free the agent if the task was running
  if (task.status._tag === "running" || task.status._tag === "assigned") {
    const agent = swarm.agents.get(task.status.agentId);
    if (agent && agent.status._tag === "busy" && agent.status.taskId === taskId) {
      agent.status = { _tag: "idle" };
    }
  }

  task.status = { _tag: "cancelled" };
  task.agentId = undefined;
  return true;
}

// ---------------------------------------------------------------------------
// dispatchPending — assign all pending tasks to available agents
// ---------------------------------------------------------------------------

/**
 * Walk the pending task queue and assign each to the best available agent.
 * Useful after an agent becomes idle or a new task arrives.
 */
export async function dispatchPending(swarm: SwarmManager): Promise<void> {
  for (const task of swarm.tasks.values()) {
    if (task.status._tag !== "pending") continue;

    const agent = findAgentForTask(swarm, task);
    if (!agent) continue;

    await dispatchToAgent(swarm, agent, task);
  }
}

// ---------------------------------------------------------------------------
// updateAgentStatus — manually set an agent's status
// ---------------------------------------------------------------------------

/**
 * Override an agent's status.  Useful for marking agents offline/online
 * or recovering from error states.
 */
export function updateAgentStatus(
  swarm: SwarmManager,
  agentId: string,
  status: SwarmAgentStatus,
): boolean {
  const agent = swarm.agents.get(agentId);
  if (!agent) return false;
  agent.status = status;
  return true;
}

// ---------------------------------------------------------------------------
// getAgent — retrieve a single agent by id
// ---------------------------------------------------------------------------

/**
 * Return the agent with the given id, or undefined if not found.
 */
export function getAgent(
  swarm: SwarmManager,
  agentId: string,
): SwarmAgent | undefined {
  return swarm.agents.get(agentId);
}

// ---------------------------------------------------------------------------
// getTask — retrieve a single task by id
// ---------------------------------------------------------------------------

/**
 * Return the task with the given id, or undefined if not found.
 */
export function getTask(
  swarm: SwarmManager,
  taskId: string,
): SwarmTask | undefined {
  return swarm.tasks.get(taskId);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find the best idle agent for a task.  Prefers agents whose capabilities
 * overlap with the task's requirements.  Falls back to any idle agent with
 * no specific capabilities.  Returns null if no idle agent is available.
 */
function findAgentForTask(
  swarm: SwarmManager,
  task: SwarmTask,
): SwarmAgent | null {
  const idleAgents: SwarmAgent[] = [];
  for (const agent of swarm.agents.values()) {
    if (agent.status._tag === "idle") {
      idleAgents.push(agent);
    }
  }
  if (idleAgents.length === 0) return null;

  // Simple capability scoring: agents with capabilities are preferred.
  // In a real system, this would match task tags/requirements against
  // agent capabilities.  For now, prefer agents that have explicit
  // capabilities listed, as they are considered "specialists".
  const specialists = idleAgents.filter((a) => a.capabilities.length > 0);
  if (specialists.length > 0) return specialists[0];

  return idleAgents[0];
}

/**
 * Dispatch a task to a specific agent: mark agent busy, mark task running,
 * invoke the handler, and clean up on completion.
 */
async function dispatchToAgent(
  swarm: SwarmManager,
  agent: SwarmAgent,
  task: SwarmTask,
): Promise<void> {
  const now = Date.now();

  // Mark agent as busy
  agent.status = { _tag: "busy", taskId: task.id, startedAt: now };

  // Mark task as running
  task.status = { _tag: "running", agentId: agent.id, startedAt: now };
  task.agentId = agent.id;

  try {
    const result = await swarm.taskHandler(task, agent);
    // Success
    task.status = { _tag: "completed", agentId: agent.id, result };
    task.result = result;
  } catch (err) {
    // Failure
    const message =
      err instanceof Error ? err.message : String(err);
    task.status = { _tag: "failed", agentId: agent.id, error: message };
  } finally {
    // Free the agent (unless it was set to offline/error externally)
    if (agent.status._tag === "busy" && agent.status.taskId === task.id) {
      agent.status = { _tag: "idle" };
    }
  }
}

/**
 * Default task handler — immediately completes with `null`.
 */
async function defaultTaskHandler(
  _task: SwarmTask,
  _agent: SwarmAgent,
): Promise<unknown> {
  return null;
}

/**
 * Generate a simple unique id with an optional prefix.
 */
let idCounter = 0;
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++idCounter}`;
}
