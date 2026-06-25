// Tests for session-notification plugin.
//
// Conventions: data + functions, no class.

import { describe, expect, it, beforeEach } from "vitest";
import {
  clearAll,
  clearSession,
  drainNotifications,
  formatNotificationsContext,
  getNotifications,
  getUnreadCount,
  listAllSessions,
  markAllAsRead,
  markAsRead,
  notifyCompaction,
  notifyError,
  notifySessionEnd,
  notifySessionStart,
  notifyToolComplete,
  notifyToolError,
  sendNotification,
  createSessionNotificationPlugin,
  type Notification,
  type NotificationType,
} from "./session-notification";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_A = "session-a";
const SESSION_B = "session-b";

// ---------------------------------------------------------------------------
// Setup: clear global store before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearAll();
});

// ---------------------------------------------------------------------------
// sendNotification + getNotifications
// ---------------------------------------------------------------------------

describe("sendNotification / getNotifications", () => {
  it("stores and retrieves a notification", async () => {
    await sendNotification("tool_complete", "Tool finished", SESSION_A);

    const results = await getNotifications(SESSION_A);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("tool_complete");
    expect(results[0].message).toBe("Tool finished");
    expect(results[0].sessionId).toBe(SESSION_A);
    expect(results[0].read).toBe(false);
    expect(typeof results[0].id).toBe("string");
    expect(results[0].id.length).toBeGreaterThan(0);
    expect(typeof results[0].timestamp).toBe("number");
  });

  it("returns shallow copies (no mutation leakage)", async () => {
    await sendNotification("error", "boom", SESSION_A);
    const results = await getNotifications(SESSION_A);

    results[0].read = true;
    const fresh = await getNotifications(SESSION_A);
    expect(fresh[0].read).toBe(false);
  });

  it("supports multiple sessions independently", async () => {
    await sendNotification("info", "msg-a", SESSION_A);
    await sendNotification("warning", "msg-b", SESSION_B);
    await sendNotification("info", "msg-c", SESSION_A);

    const a = await getNotifications(SESSION_A);
    const b = await getNotifications(SESSION_B);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
    expect(b[0].message).toBe("msg-b");
  });

  it("attaches optional meta", async () => {
    await sendNotification("tool_complete", "done", SESSION_A, { tool: "bash", latency: 42 });

    const results = await getNotifications(SESSION_A);
    expect(results[0].meta).toEqual({ tool: "bash", latency: 42 });
  });

  it("returns created notification with id", async () => {
    const n = await sendNotification("info", "test", SESSION_A);
    expect(typeof n.id).toBe("string");
    expect(n.id.length).toBeGreaterThan(0);
    expect(n.type).toBe("info");
    expect(n.message).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe("getNotifications filtering", () => {
  it("filters by type", async () => {
    await sendNotification("tool_complete", "t1", SESSION_A);
    await sendNotification("error", "e1", SESSION_A);
    await sendNotification("tool_complete", "t2", SESSION_A);

    const tools = await getNotifications(SESSION_A, { type: "tool_complete" });
    expect(tools).toHaveLength(2);

    const errors = await getNotifications(SESSION_A, { type: "error" });
    expect(errors).toHaveLength(1);
  });

  it("filters by unreadOnly", async () => {
    await sendNotification("info", "read-one", SESSION_A);
    await sendNotification("info", "unread-one", SESSION_A);

    const all = await getNotifications(SESSION_A);
    markAsRead(all[0].id);

    const unread = await getNotifications(SESSION_A, { unreadOnly: true });
    expect(unread).toHaveLength(1);
    expect(unread[0].message).toBe("unread-one");
  });

  it("filters by since timestamp", async () => {
    const first = await sendNotification("info", "old", SESSION_A);
    // Use the first notification's timestamp + 1 to guarantee separation
    const afterFirst = first.timestamp + 1;
    await sendNotification("info", "new", SESSION_A);

    const recent = await getNotifications(SESSION_A, { since: afterFirst });
    expect(recent).toHaveLength(1);
    expect(recent[0].message).toBe("new");
  });

  it("limits results", async () => {
    for (let i = 0; i < 10; i++) {
      await sendNotification("info", `msg-${i}`, SESSION_A);
    }

    const last3 = await getNotifications(SESSION_A, { limit: 3 });
    expect(last3).toHaveLength(3);
    expect(last3[0].message).toBe("msg-7");
  });
});

// ---------------------------------------------------------------------------
// Read / unread
// ---------------------------------------------------------------------------

describe("markAsRead / markAllAsRead", () => {
  it("marks a single notification as read", async () => {
    const n = await sendNotification("info", "a", SESSION_A);
    await sendNotification("info", "b", SESSION_A);

    markAsRead(n.id);
    const unread = await getNotifications(SESSION_A, { unreadOnly: true });
    expect(unread).toHaveLength(1);
    expect(unread[0].message).toBe("b");
  });

  it("markAllAsRead marks all in a session", async () => {
    await sendNotification("info", "a", SESSION_A);
    await sendNotification("info", "b", SESSION_A);

    markAllAsRead(SESSION_A);
    const unread = await getNotifications(SESSION_A, { unreadOnly: true });
    expect(unread).toHaveLength(0);
  });

  it("markAsRead is a no-op for unknown id", () => {
    markAsRead("nonexistent-id");
    // Should not throw
  });
});

// ---------------------------------------------------------------------------
// getUnreadCount
// ---------------------------------------------------------------------------

describe("getUnreadCount", () => {
  it("counts unread notifications", async () => {
    await sendNotification("info", "a", SESSION_A);
    await sendNotification("info", "b", SESSION_A);
    await sendNotification("info", "c", SESSION_A);

    expect(getUnreadCount(SESSION_A)).toBe(3);

    markAllAsRead(SESSION_A);
    expect(getUnreadCount(SESSION_A)).toBe(0);
  });

  it("returns 0 for unknown session", () => {
    expect(getUnreadCount("unknown")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// drainNotifications
// ---------------------------------------------------------------------------

describe("drainNotifications", () => {
  it("returns and marks all unread as read", async () => {
    await sendNotification("info", "a", SESSION_A);
    await sendNotification("error", "b", SESSION_A);

    const drained = drainNotifications(SESSION_A);
    expect(drained).toHaveLength(2);

    // Second drain returns nothing
    const empty = drainNotifications(SESSION_A);
    expect(empty).toHaveLength(0);
  });

  it("returns empty for unknown session", () => {
    expect(drainNotifications("unknown")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// clearSession / clearAll
// ---------------------------------------------------------------------------

describe("clearSession / clearAll", () => {
  it("clearSession removes only that session", async () => {
    await sendNotification("info", "a", SESSION_A);
    await sendNotification("info", "b", SESSION_B);

    clearSession(SESSION_A);

    expect(await getNotifications(SESSION_A)).toHaveLength(0);
    expect(await getNotifications(SESSION_B)).toHaveLength(1);
  });

  it("clearAll removes everything", async () => {
    await sendNotification("info", "a", SESSION_A);
    await sendNotification("info", "b", SESSION_B);

    clearAll();

    expect(await getNotifications(SESSION_A)).toHaveLength(0);
    expect(await getNotifications(SESSION_B)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listAllSessions
// ---------------------------------------------------------------------------

describe("listAllSessions", () => {
  it("returns all session IDs with notifications", async () => {
    await sendNotification("info", "a", SESSION_A);
    await sendNotification("info", "b", SESSION_B);

    const sessions = listAllSessions();
    expect(sessions).toContain(SESSION_A);
    expect(sessions).toContain(SESSION_B);
    expect(sessions).toHaveLength(2);
  });

  it("returns empty array when store is empty", () => {
    expect(listAllSessions()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatNotificationsContext
// ---------------------------------------------------------------------------

describe("formatNotificationsContext", () => {
  it("returns empty string for no notifications", () => {
    expect(formatNotificationsContext([])).toBe("");
  });

  it("formats notifications into readable context", () => {
    const notifications: Notification[] = [
      {
        id: "1",
        type: "tool_complete",
        message: "bash finished",
        sessionId: "s1",
        timestamp: Date.now(),
        read: false,
        meta: { tool: "bash" },
      },
      {
        id: "2",
        type: "error",
        message: "something failed",
        sessionId: "s1",
        timestamp: Date.now(),
        read: false,
      },
    ];

    const ctx = formatNotificationsContext(notifications);
    expect(ctx).toContain("TOOL_COMPLETE");
    expect(ctx).toContain("bash finished");
    expect(ctx).toContain("ERROR");
    expect(ctx).toContain("something failed");
    expect(ctx).toContain("Session notifications");
    expect(ctx).toContain("Review these notifications");
  });

  it("omits meta line when no meta", () => {
    const notifications: Notification[] = [
      {
        id: "1",
        type: "info",
        message: "test",
        sessionId: "s1",
        timestamp: Date.now(),
        read: false,
      },
    ];

    const ctx = formatNotificationsContext(notifications);
    expect(ctx).not.toContain("meta:");
  });
});

// ---------------------------------------------------------------------------
// Convenience factories
// ---------------------------------------------------------------------------

describe("convenience factories", () => {
  it("notifyToolComplete", async () => {
    const n = await notifyToolComplete(SESSION_A, "bash", "completed successfully");
    expect(n.type).toBe("tool_complete");
    expect(n.meta).toEqual({ tool: "bash" });
    expect(n.message).toBe("completed successfully");
  });

  it("notifyToolError", async () => {
    const n = await notifyToolError(SESSION_A, "edit", "file not found");
    expect(n.type).toBe("tool_error");
    expect(n.meta).toEqual({ tool: "edit" });
  });

  it("notifyError", async () => {
    const n = await notifyError(SESSION_A, "LLM provider unavailable");
    expect(n.type).toBe("error");
  });

  it("notifySessionEnd", async () => {
    const n = await notifySessionEnd(SESSION_A, "completed");
    expect(n.type).toBe("session_end");
    expect(n.message).toBe("completed");
  });

  it("notifySessionStart", async () => {
    const n = await notifySessionStart(SESSION_A);
    expect(n.type).toBe("session_start");
  });

  it("notifyCompaction", async () => {
    const n = await notifyCompaction(SESSION_A, "Context compacted");
    expect(n.type).toBe("compaction");
  });
});

// ---------------------------------------------------------------------------
// createSessionNotificationPlugin
// ---------------------------------------------------------------------------

describe("createSessionNotificationPlugin", () => {
  it("returns a valid plugin descriptor", () => {
    const plugin = createSessionNotificationPlugin();
    expect(plugin.name).toBe("session-notification");
    expect(plugin.version).toBe("0.1.0");
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.teardown).toBe("function");
  });

  it("exposes notification namespace", () => {
    const plugin = createSessionNotificationPlugin();
    expect(plugin.notifications).toBeDefined();
    expect(typeof plugin.notifications.sendNotification).toBe("function");
    expect(typeof plugin.notifications.getNotifications).toBe("function");
    expect(typeof plugin.notifications.drainNotifications).toBe("function");
    expect(typeof plugin.notifications.formatNotificationsContext).toBe("function");
    expect(typeof plugin.notifications.clearAll).toBe("function");
  });

  it("teardown clears all notifications", async () => {
    const plugin = createSessionNotificationPlugin();
    await sendNotification("info", "test", SESSION_A);

    plugin.teardown!();

    const results = await getNotifications(SESSION_A);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// All notification types
// ---------------------------------------------------------------------------

describe("all notification types", () => {
  const types: NotificationType[] = [
    "tool_complete",
    "tool_error",
    "error",
    "session_end",
    "session_start",
    "compaction",
    "warning",
    "info",
  ];

  for (const type of types) {
    it(`supports type: ${type}`, async () => {
      await sendNotification(type, `message for ${type}`, SESSION_A);
      const results = await getNotifications(SESSION_A, { type });
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe(type);
    });
  }
});
