// Tests for Swarm multi-agent orchestration engine (src/core/swarm.ts)
//
// Covers:
//   - createSwarm: initialization and default state
//   - assignTask: capability matching, handler invocation, status transitions
//   - getSwarmStatus: counts across all agent/task states
//   - sendMessage / getMessages: inter-agent communication
//   - retryTask: re-dispatch of failed/pending tasks
//   - cancelTask: cancellation of tasks in various states
//   - dispatchPending: batch assignment of pending tasks
//   - updateAgentStatus: manual agent status override
//   - getAgent / getTask: lookups
//   - edge cases: duplicate task ids, missing agents, terminal states

import { describe, expect, it } from "vitest";

import {
  assignTask,
  cancelTask,
  createSwarm,
  dispatchPending,
  getAgent,
  getAgentTasks,
  getMessages,
  getSwarmStatus,
  getTask,
  retryTask,
  sendMessage,
  updateAgentStatus,
} from "./swarm";
import type { SwarmAgent, SwarmManager, SwarmTask } from "./swarm";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(
  id: string,
  role: string,
  capabilities: string[] = [],
): SwarmAgent {
  return {
    id,
    role,
    capabilities,
    status: { _tag: "idle" },
  };
}

function makeTask(id: string, prompt: string): SwarmTask {
  return {
    id,
    prompt,
    status: { _tag: "pending" },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// createSwarm
// ---------------------------------------------------------------------------

describe("createSwarm", () => {
  it("initializes agents with idle status", () => {
    const agents = [
      makeAgent("a1", "coder", ["typescript"]),
      makeAgent("a2", "reviewer", ["code-review"]),
    ];
    const swarm = createSwarm(agents);

    expect(swarm.agents.size).toBe(2);
    expect(swarm.tasks.size).toBe(0);
    expect(swarm.messages).toEqual([]);

    const a1 = swarm.agents.get("a1");
    expect(a1?.role).toBe("coder");
    expect(a1?.status._tag).toBe("idle");
  });

  it("resets existing agent statuses to idle", () => {
    const busyAgent: SwarmAgent = {
      id: "a1",
      role: "coder",
      capabilities: [],
      status: { _tag: "busy", taskId: "old", startedAt: 0 },
    };
    const swarm = createSwarm([busyAgent]);
    expect(swarm.agents.get("a1")?.status._tag).toBe("idle");
  });

  it("creates swarm with empty agent list", () => {
    const swarm = createSwarm([]);
    expect(swarm.agents.size).toBe(0);
    expect(getSwarmStatus(swarm).totalAgents).toBe(0);
  });

  it("accepts custom task handler", async () => {
    let called = false;
    const swarm = createSwarm([makeAgent("a1", "worker")], {
      taskHandler: async () => {
        called = true;
        return "custom-result";
      },
    });
    await assignTask(swarm, makeTask("t1", "do something"));
    expect(called).toBe(true);
    expect(getTask(swarm, "t1")?.result).toBe("custom-result");
  });
});

// ---------------------------------------------------------------------------
// assignTask
// ---------------------------------------------------------------------------

describe("assignTask", () => {
  it("assigns a pending task to an idle agent", async () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);
    await assignTask(swarm, makeTask("t1", "write code"));

    const task = getTask(swarm, "t1");
    expect(task?.status._tag).toBe("completed");
    expect(task?.agentId).toBe("a1");

    const agent = getAgent(swarm, "a1");
    expect(agent?.status._tag).toBe("idle"); // freed after completion
  });

  it("marks task as completed with handler result", async () => {
    const swarm = createSwarm([makeAgent("a1", "coder")], {
      taskHandler: async () => "the-result",
    });
    await assignTask(swarm, makeTask("t1", "compute"));

    expect(getTask(swarm, "t1")?.status._tag).toBe("completed");
    expect(getTask(swarm, "t1")?.result).toBe("the-result");
  });

  it("marks task as failed when handler throws", async () => {
    const swarm = createSwarm([makeAgent("a1", "coder")], {
      taskHandler: async () => {
        throw new Error("boom");
      },
    });
    await assignTask(swarm, makeTask("t1", "failing task"));

    const task = getTask(swarm, "t1");
    expect(task?.status._tag).toBe("failed");

    // Agent should be freed even on failure
    expect(getAgent(swarm, "a1")?.status._tag).toBe("idle");
  });

  it("leaves task pending when no idle agent available", async () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);
    // Mark agent busy after createSwarm (which resets to idle)
    updateAgentStatus(swarm, "a1", {
      _tag: "busy",
      taskId: "other",
      startedAt: Date.now(),
    });
    await assignTask(swarm, makeTask("t1", "wait for me"));

    expect(getTask(swarm, "t1")?.status._tag).toBe("pending");
  });

  it("rejects duplicate task ids", async () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);
    await assignTask(swarm, makeTask("t1", "first"));
    await assignTask(swarm, makeTask("t1", "duplicate"));

    // Only one task with id "t1" should exist
    const tasks = getAgentTasks(swarm, "a1");
    expect(tasks.filter((t) => t.id === "t1")).toHaveLength(1);
  });

  it("assigns multiple tasks to multiple agents", async () => {
    const swarm = createSwarm([
      makeAgent("a1", "coder"),
      makeAgent("a2", "reviewer"),
    ]);

    // First task goes to a1, second to a2
    await assignTask(swarm, makeTask("t1", "code"));
    await assignTask(swarm, makeTask("t2", "review"));

    expect(getTask(swarm, "t1")?.status._tag).toBe("completed");
    expect(getTask(swarm, "t2")?.status._tag).toBe("completed");
  });

  it("prefers specialist agents with capabilities", async () => {
    let assignedRole = "";
    const swarm = createSwarm(
      [
        makeAgent("a1", "generalist"),
        makeAgent("a2", "specialist", ["typescript"]),
      ],
      {
        taskHandler: async (_task, agent) => {
          assignedRole = agent.role;
          return null;
        },
      },
    );
    await assignTask(swarm, makeTask("t1", "write typescript"));

    expect(assignedRole).toBe("specialist");
  });
});

// ---------------------------------------------------------------------------
// getSwarmStatus
// ---------------------------------------------------------------------------

describe("getSwarmStatus", () => {
  it("reports correct counts for idle agents", () => {
    const swarm = createSwarm([
      makeAgent("a1", "coder"),
      makeAgent("a2", "reviewer"),
    ]);
    const status = getSwarmStatus(swarm);

    expect(status.totalAgents).toBe(2);
    expect(status.idleAgents).toBe(2);
    expect(status.busyAgents).toBe(0);
    expect(status.offlineAgents).toBe(0);
    expect(status.errorAgents).toBe(0);
  });

  it("reports correct counts after task assignment", async () => {
    let handlerResolve: (() => void) | undefined;
    const handlerBlocked = new Promise<void>((resolve) => {
      handlerResolve = resolve;
    });

    const swarm = createSwarm([makeAgent("a1", "coder")], {
      taskHandler: async () => {
        await handlerBlocked;
        return "done";
      },
    });

    const assignPromise = assignTask(swarm, makeTask("t1", "long task"));

    // Give the handler a tick to start
    await delay(10);

    const midStatus = getSwarmStatus(swarm);
    expect(midStatus.busyAgents).toBe(1);
    expect(midStatus.idleAgents).toBe(0);
    expect(midStatus.runningTasks).toBe(1);

    // Unblock the handler
    handlerResolve?.();
    await assignPromise;

    const finalStatus = getSwarmStatus(swarm);
    expect(finalStatus.idleAgents).toBe(1);
    expect(finalStatus.busyAgents).toBe(0);
    expect(finalStatus.completedTasks).toBe(1);
    expect(finalStatus.runningTasks).toBe(0);
  });

  it("counts tasks across all states", () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);

    // Manually insert tasks in various states
    swarm.tasks.set("t1", {
      id: "t1",
      prompt: "pending",
      status: { _tag: "pending" },
    });
    swarm.tasks.set("t2", {
      id: "t2",
      prompt: "completed",
      status: { _tag: "completed", agentId: "a1", result: null },
    });
    swarm.tasks.set("t3", {
      id: "t3",
      prompt: "failed",
      status: { _tag: "failed", agentId: "a1", error: "oops" },
    });
    swarm.tasks.set("t4", {
      id: "t4",
      prompt: "cancelled",
      status: { _tag: "cancelled" },
    });

    const status = getSwarmStatus(swarm);
    expect(status.totalTasks).toBe(4);
    expect(status.pendingTasks).toBe(1);
    expect(status.completedTasks).toBe(1);
    expect(status.failedTasks).toBe(1);
    expect(status.cancelledTasks).toBe(1);
  });

  it("counts offline and error agents", () => {
    const swarm = createSwarm([
      makeAgent("a1", "coder"),
      makeAgent("a2", "reviewer"),
      makeAgent("a3", "tester"),
    ]);

    updateAgentStatus(swarm, "a2", { _tag: "offline" });
    updateAgentStatus(swarm, "a3", { _tag: "error", message: "crashed" });

    const status = getSwarmStatus(swarm);
    expect(status.idleAgents).toBe(1);
    expect(status.offlineAgents).toBe(1);
    expect(status.errorAgents).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sendMessage / getMessages
// ---------------------------------------------------------------------------

describe("sendMessage", () => {
  it("creates a message with id and timestamp", () => {
    const swarm = createSwarm([makeAgent("a1", "coder"), makeAgent("a2", "reviewer")]);
    const msg = sendMessage(swarm, {
      fromAgentId: "a1",
      toAgentId: "a2",
      content: "here is the code",
    });

    expect(msg.id).toBeTruthy();
    expect(msg.timestamp).toBeGreaterThan(0);
    expect(msg.fromAgentId).toBe("a1");
    expect(msg.toAgentId).toBe("a2");
    expect(msg.content).toBe("here is the code");
  });

  it("stores message in the swarm", () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);
    sendMessage(swarm, {
      fromAgentId: "a1",
      toAgentId: "a1",
      content: "self-note",
    });

    expect(swarm.messages).toHaveLength(1);
  });

  it("supports task-scoped messages", () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);
    const msg = sendMessage(swarm, {
      fromAgentId: "a1",
      toAgentId: "a1",
      content: "task update",
      taskId: "t1",
    });

    expect(msg.taskId).toBe("t1");
  });
});

describe("getMessages", () => {
  it("returns messages addressed to the agent", () => {
    const swarm = createSwarm([makeAgent("a1", "coder"), makeAgent("a2", "reviewer")]);
    sendMessage(swarm, { fromAgentId: "a1", toAgentId: "a2", content: "msg1" });
    sendMessage(swarm, { fromAgentId: "a2", toAgentId: "a1", content: "msg2" });
    sendMessage(swarm, { fromAgentId: "a1", toAgentId: "a2", content: "msg3" });

    const msgs = getMessages(swarm, "a2");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe("msg1");
    expect(msgs[1].content).toBe("msg3");
  });

  it("filters by taskId when specified", () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);
    sendMessage(swarm, {
      fromAgentId: "a1",
      toAgentId: "a1",
      content: "task-scoped",
      taskId: "t1",
    });
    sendMessage(swarm, {
      fromAgentId: "a1",
      toAgentId: "a1",
      content: "general",
    });

    const taskMsgs = getMessages(swarm, "a1", { taskId: "t1" });
    expect(taskMsgs).toHaveLength(1);
    expect(taskMsgs[0].content).toBe("task-scoped");

    const allMsgs = getMessages(swarm, "a1");
    expect(allMsgs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getAgentTasks
// ---------------------------------------------------------------------------

describe("getAgentTasks", () => {
  it("returns tasks assigned to a specific agent", async () => {
    // Use a long-running handler so agents stay busy and tasks go to
    // different agents (dispatch is sequential: t1 starts on a1, t2 on a2)
    const swarm = createSwarm(
      [makeAgent("a1", "coder"), makeAgent("a2", "reviewer")],
      {
        taskHandler: async (task, agent) => {
          await delay(10);
          return `${agent.id}:${task.id}`;
        },
      },
    );
    const p1 = assignTask(swarm, makeTask("t1", "code"));
    // t1 is running on a1 by the time t2 is dispatched
    await delay(1);
    const p2 = assignTask(swarm, makeTask("t2", "review"));
    await Promise.all([p1, p2]);

    const a1Tasks = getAgentTasks(swarm, "a1");
    expect(a1Tasks).toHaveLength(1);
    expect(a1Tasks[0].id).toBe("t1");

    const a2Tasks = getAgentTasks(swarm, "a2");
    expect(a2Tasks).toHaveLength(1);
    expect(a2Tasks[0].id).toBe("t2");
  });

  it("returns empty array for agent with no tasks", () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);
    expect(getAgentTasks(swarm, "a1")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// retryTask
// ---------------------------------------------------------------------------

describe("retryTask", () => {
  it("retries a failed task", async () => {
    let callCount = 0;
    const swarm = createSwarm([makeAgent("a1", "coder")], {
      taskHandler: async () => {
        callCount++;
        if (callCount === 1) throw new Error("first failure");
        return "recovered";
      },
    });

    await assignTask(swarm, makeTask("t1", "flaky task"));
    expect(getTask(swarm, "t1")?.status._tag).toBe("failed");

    await retryTask(swarm, "t1");
    expect(getTask(swarm, "t1")?.status._tag).toBe("completed");
    expect(getTask(swarm, "t1")?.result).toBe("recovered");
    expect(callCount).toBe(2);
  });

  it("retries a pending task (no agent was available initially)", async () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);
    // Mark agent busy after createSwarm so it stays busy during assign
    updateAgentStatus(swarm, "a1", {
      _tag: "busy",
      taskId: "other",
      startedAt: Date.now(),
    });
    await assignTask(swarm, makeTask("t1", "stuck"));
    expect(getTask(swarm, "t1")?.status._tag).toBe("pending");

    // Free the agent
    updateAgentStatus(swarm, "a1", { _tag: "idle" });
    await retryTask(swarm, "t1");

    expect(getTask(swarm, "t1")?.status._tag).toBe("completed");
  });

  it("ignores retry on completed task", async () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);
    await assignTask(swarm, makeTask("t1", "done"));
    expect(getTask(swarm, "t1")?.status._tag).toBe("completed");

    await retryTask(swarm, "t1");
    // Should remain completed, not re-dispatched
    expect(getTask(swarm, "t1")?.status._tag).toBe("completed");
  });

  it("ignores retry on nonexistent task", async () => {
    const swarm = createSwarm([]);
    await retryTask(swarm, "nonexistent"); // should not throw
  });
});

// ---------------------------------------------------------------------------
// cancelTask
// ---------------------------------------------------------------------------

describe("cancelTask", () => {
  it("cancels a pending task", () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);
    swarm.tasks.set("t1", makeTask("t1", "pending task"));

    const result = cancelTask(swarm, "t1");
    expect(result).toBe(true);
    expect(getTask(swarm, "t1")?.status._tag).toBe("cancelled");
  });

  it("cancels a running task and frees the agent", () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);
    swarm.tasks.set("t1", {
      id: "t1",
      agentId: "a1",
      prompt: "running",
      status: { _tag: "running", agentId: "a1", startedAt: Date.now() },
    });
    swarm.agents.get("a1")!.status = {
      _tag: "busy",
      taskId: "t1",
      startedAt: Date.now(),
    };

    const result = cancelTask(swarm, "t1");
    expect(result).toBe(true);
    expect(getTask(swarm, "t1")?.status._tag).toBe("cancelled");
    expect(getAgent(swarm, "a1")?.status._tag).toBe("idle");
  });

  it("cannot cancel a completed task", async () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);
    await assignTask(swarm, makeTask("t1", "done"));

    const result = cancelTask(swarm, "t1");
    expect(result).toBe(false);
    expect(getTask(swarm, "t1")?.status._tag).toBe("completed");
  });

  it("cannot cancel a failed task", async () => {
    const swarm = createSwarm([makeAgent("a1", "coder")], {
      taskHandler: async () => {
        throw new Error("fail");
      },
    });
    await assignTask(swarm, makeTask("t1", "bad task"));

    const result = cancelTask(swarm, "t1");
    expect(result).toBe(false);
  });

  it("returns false for nonexistent task", () => {
    const swarm = createSwarm([]);
    expect(cancelTask(swarm, "nope")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispatchPending
// ---------------------------------------------------------------------------

describe("dispatchPending", () => {
  it("assigns all pending tasks to available agents", async () => {
    // Start with no agents — tasks will be pending
    const swarm = createSwarm([]);
    await assignTask(swarm, makeTask("t1", "first"));
    await assignTask(swarm, makeTask("t2", "second"));

    expect(getTask(swarm, "t1")?.status._tag).toBe("pending");
    expect(getTask(swarm, "t2")?.status._tag).toBe("pending");

    // Add agents and dispatch
    swarm.agents.set("a1", makeAgent("a1", "coder"));
    swarm.agents.set("a2", makeAgent("a2", "reviewer"));

    await dispatchPending(swarm);

    expect(getTask(swarm, "t1")?.status._tag).toBe("completed");
    expect(getTask(swarm, "t2")?.status._tag).toBe("completed");
  });

  it("skips non-pending tasks", async () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);
    await assignTask(swarm, makeTask("t1", "done"));
    expect(getTask(swarm, "t1")?.status._tag).toBe("completed");

    // dispatchPending should not touch completed tasks
    await dispatchPending(swarm);
    expect(getTask(swarm, "t1")?.status._tag).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// updateAgentStatus
// ---------------------------------------------------------------------------

describe("updateAgentStatus", () => {
  it("updates agent status successfully", () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);

    const result = updateAgentStatus(swarm, "a1", { _tag: "offline" });
    expect(result).toBe(true);
    expect(getAgent(swarm, "a1")?.status._tag).toBe("offline");
  });

  it("returns false for nonexistent agent", () => {
    const swarm = createSwarm([]);
    const result = updateAgentStatus(swarm, "ghost", { _tag: "offline" });
    expect(result).toBe(false);
  });

  it("can recover an errored agent to idle", () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);
    updateAgentStatus(swarm, "a1", { _tag: "error", message: "crashed" });
    expect(getAgent(swarm, "a1")?.status._tag).toBe("error");

    updateAgentStatus(swarm, "a1", { _tag: "idle" });
    expect(getAgent(swarm, "a1")?.status._tag).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// getAgent / getTask
// ---------------------------------------------------------------------------

describe("getAgent", () => {
  it("returns agent by id", () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);
    const agent = getAgent(swarm, "a1");
    expect(agent?.id).toBe("a1");
    expect(agent?.role).toBe("coder");
  });

  it("returns undefined for missing id", () => {
    const swarm = createSwarm([]);
    expect(getAgent(swarm, "nope")).toBeUndefined();
  });
});

describe("getTask", () => {
  it("returns task by id", async () => {
    const swarm = createSwarm([makeAgent("a1", "coder")]);
    await assignTask(swarm, makeTask("t1", "do it"));

    const task = getTask(swarm, "t1");
    expect(task?.id).toBe("t1");
    expect(task?.prompt).toBe("do it");
  });

  it("returns undefined for missing id", () => {
    const swarm = createSwarm([]);
    expect(getTask(swarm, "nope")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Agent communication + task coordination
// ---------------------------------------------------------------------------

describe("agent communication and coordination", () => {
  it("enables multi-agent handoff via messages", async () => {
    // Agent 1 writes code, sends to agent 2 for review
    const swarm = createSwarm([
      makeAgent("coder", "coder", ["typescript"]),
      makeAgent("reviewer", "reviewer", ["code-review"]),
    ]);

    await assignTask(swarm, makeTask("t1", "implement feature"));

    // Coder sends result to reviewer
    const msg = sendMessage(swarm, {
      fromAgentId: "coder",
      toAgentId: "reviewer",
      content: "Feature implemented, please review",
      taskId: "t1",
    });

    // Reviewer picks up the message
    const reviewMsgs = getMessages(swarm, "reviewer", { taskId: "t1" });
    expect(reviewMsgs).toHaveLength(1);
    expect(reviewMsgs[0].content).toBe("Feature implemented, please review");
  });

  it("tracks agent workload across multiple tasks", async () => {
    const swarm = createSwarm([
      makeAgent("a1", "coder"),
      makeAgent("a2", "coder"),
    ]);

    await assignTask(swarm, makeTask("t1", "task 1"));
    await assignTask(swarm, makeTask("t2", "task 2"));

    const a1Tasks = getAgentTasks(swarm, "a1");
    const a2Tasks = getAgentTasks(swarm, "a2");

    // Both agents should have been used
    expect(a1Tasks.length + a2Tasks.length).toBe(2);
  });

  it("full lifecycle: create, assign, message, complete", async () => {
    const results: string[] = [];

    const swarm = createSwarm(
      [
        makeAgent("planner", "planner", ["planning"]),
        makeAgent("executor", "executor", ["execution"]),
      ],
      {
        taskHandler: async (task, agent) => {
          results.push(`${agent.role}:${task.id}`);
          return `done-${task.id}`;
        },
      },
    );

    // Planner creates a plan and messages the executor
    sendMessage(swarm, {
      fromAgentId: "planner",
      toAgentId: "executor",
      content: "Execute step 1: build the feature",
    });

    // Executor receives the plan
    const instructions = getMessages(swarm, "executor");
    expect(instructions).toHaveLength(1);
    expect(instructions[0].content).toContain("build the feature");

    // Mark planner busy so executor gets the task
    updateAgentStatus(swarm, "planner", {
      _tag: "busy",
      taskId: "other",
      startedAt: Date.now(),
    });
    await assignTask(swarm, makeTask("t1", "build the feature"));

    const task = getTask(swarm, "t1");
    expect(task?.status._tag).toBe("completed");
    expect(task?.result).toBe("done-t1");
    expect(results).toEqual(["executor:t1"]);

    // Status check (planner was manually set busy, only executor is idle)
    const status = getSwarmStatus(swarm);
    expect(status.completedTasks).toBe(1);
    expect(status.totalMessages).toBe(1);
    expect(status.idleAgents).toBe(1);
  });
});
