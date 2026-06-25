// Session notification system.
//
// Provides an in-memory, session-scoped notification queue that allows
// the agent loop and external consumers to send and receive structured
// notifications at key execution points (tool completion, errors, session
// end, etc.).
//
// Notifications are scoped to a session ID and can be queried, read, and
// filtered by type.  A plugin factory (createSessionNotificationPlugin)
// wires into the existing plugin lifecycle and can trigger notifications
// automatically at agent-loop hook points.
//
// Conventions: data + functions, no class, no enum.

import type { Plugin, PluginContext, PluginLogger } from "./types";

// ---------------------------------------------------------------------------
// NotificationType — the built-in notification categories.
//
// Using a string union (no enum) per project conventions.
// ---------------------------------------------------------------------------

export type NotificationType =
  | "tool_complete"
  | "tool_error"
  | "error"
  | "session_end"
  | "session_start"
  | "compaction"
  | "warning"
  | "info";

// ---------------------------------------------------------------------------
// Notification — a single session-scoped notification.
// ---------------------------------------------------------------------------

export type Notification = {
  id: string;
  type: NotificationType;
  message: string;
  sessionId: string;
  timestamp: number;
  read: boolean;
  /** Optional structured metadata attached to the notification. */
  meta?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// NotificationFilter — query parameters for getNotifications.
// ---------------------------------------------------------------------------

export type NotificationFilter = {
  type?: NotificationType;
  unreadOnly?: boolean;
  since?: number;
  limit?: number;
};

// ---------------------------------------------------------------------------
// Module-level store: sessionId → notifications[]
// ---------------------------------------------------------------------------

const store = new Map<string, Notification[]>();

// ---------------------------------------------------------------------------
// sendNotification — create and store a notification for a session.
//
// Returns a shallow copy of the created notification so callers can
// reference the assigned ID without mutating the store.
// ---------------------------------------------------------------------------

export function sendNotification(
  type: NotificationType,
  message: string,
  sessionId: string,
  meta?: Record<string, unknown>,
): Promise<Notification> {
  const notification: Notification = {
    id: crypto.randomUUID(),
    type,
    message,
    sessionId,
    timestamp: Date.now(),
    read: false,
    meta,
  };

  const queue = store.get(sessionId);
  if (queue) {
    queue.push(notification);
  } else {
    store.set(sessionId, [notification]);
  }

  return Promise.resolve({ ...notification });
}

// ---------------------------------------------------------------------------
// getNotifications — retrieve notifications for a session.
//
// Returns shallow copies so callers cannot mutate the internal store.
// Supports optional filtering by type, read status, recency, and limit.
// ---------------------------------------------------------------------------

export function getNotifications(
  sessionId: string,
  filter?: NotificationFilter,
): Promise<Notification[]> {
  const all = store.get(sessionId) ?? [];
  let result = all;

  if (filter?.type) {
    result = result.filter((n) => n.type === filter.type);
  }
  if (filter?.unreadOnly) {
    result = result.filter((n) => !n.read);
  }
  if (filter?.since !== undefined) {
    result = result.filter((n) => n.timestamp >= filter.since!);
  }
  if (filter?.limit !== undefined) {
    result = result.slice(-filter.limit!);
  }

  return Promise.resolve(result.map((n) => ({ ...n })));
}

// ---------------------------------------------------------------------------
// markAsRead — mark a specific notification as read by its ID.
// ---------------------------------------------------------------------------

export function markAsRead(notificationId: string): void {
  for (const queue of store.values()) {
    for (const n of queue) {
      if (n.id === notificationId) {
        n.read = true;
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// markAllAsRead — mark every notification in a session as read.
// ---------------------------------------------------------------------------

export function markAllAsRead(sessionId: string): void {
  const queue = store.get(sessionId);
  if (!queue) return;
  for (const n of queue) {
    n.read = true;
  }
}

// ---------------------------------------------------------------------------
// getUnreadCount — lightweight count of unread notifications for a session.
// ---------------------------------------------------------------------------

export function getUnreadCount(sessionId: string): number {
  const queue = store.get(sessionId);
  if (!queue) return 0;
  return queue.filter((n) => !n.read).length;
}

// ---------------------------------------------------------------------------
// clearSession — remove all notifications for a session.
// ---------------------------------------------------------------------------

export function clearSession(sessionId: string): void {
  store.delete(sessionId);
}

// ---------------------------------------------------------------------------
// clearAll — remove all notifications (useful for testing and teardown).
// ---------------------------------------------------------------------------

export function clearAll(): void {
  store.clear();
}

// ---------------------------------------------------------------------------
// listAllSessions — return session IDs that have notifications.
// ---------------------------------------------------------------------------

export function listAllSessions(): string[] {
  return [...store.keys()];
}

// ---------------------------------------------------------------------------
// drainNotifications — retrieve and mark as read all unread notifications.
//
// Mirrors the mailbox drain pattern: used by the agent loop to consume
// pending notifications and inject them as context.
// ---------------------------------------------------------------------------

export function drainNotifications(sessionId: string): Notification[] {
  const queue = store.get(sessionId);
  if (!queue || queue.length === 0) return [];
  const unread = queue.filter((n) => !n.read);
  for (const n of unread) {
    n.read = true;
  }
  return unread.map((n) => ({ ...n }));
}

// ---------------------------------------------------------------------------
// formatNotificationsContext — format drained notifications into a prompt.
//
// Returns an empty string when there are no notifications, so callers can
// safely splice the result into a system prompt without extra guards.
// ---------------------------------------------------------------------------

export function formatNotificationsContext(notifications: Notification[]): string {
  if (notifications.length === 0) return "";

  const blocks = notifications.map(
    (n) =>
      `[${n.type.toUpperCase()}] ${n.message}\n  at: ${new Date(n.timestamp).toISOString()}` +
      (n.meta ? `\n  meta: ${JSON.stringify(n.meta)}` : ""),
  );

  return (
    `Session notifications:\n\n${blocks.join("\n\n")}\n\n` +
    "Review these notifications and take appropriate action if needed."
  );
}

// ---------------------------------------------------------------------------
// Convenience factories — pre-typed helpers for the most common notification
// kinds.  Each returns the created Notification.
// ---------------------------------------------------------------------------

export function notifyToolComplete(
  sessionId: string,
  tool: string,
  summary: string,
): Promise<Notification> {
  return sendNotification("tool_complete", summary, sessionId, { tool });
}

export function notifyToolError(
  sessionId: string,
  tool: string,
  error: string,
): Promise<Notification> {
  return sendNotification("tool_error", error, sessionId, { tool });
}

export function notifyError(
  sessionId: string,
  message: string,
): Promise<Notification> {
  return sendNotification("error", message, sessionId);
}

export function notifySessionEnd(
  sessionId: string,
  reason: string,
): Promise<Notification> {
  return sendNotification("session_end", reason, sessionId);
}

export function notifySessionStart(sessionId: string): Promise<Notification> {
  return sendNotification("session_start", "Session started", sessionId);
}

export function notifyCompaction(
  sessionId: string,
  summary: string,
): Promise<Notification> {
  return sendNotification("compaction", summary, sessionId);
}

// ---------------------------------------------------------------------------
// createSessionNotificationPlugin — Plugin factory.
//
// Returns a Plugin descriptor that, when activated, hooks into the plugin
// lifecycle and wires up automatic notifications at key agent-loop points.
//
// The plugin does not register hooks directly; instead it exposes the
// notification functions above.  Consumers can call them explicitly from
// the agent loop, or this plugin can be extended to register hooks on
// the HookMap points ("tool:after", "session:create", etc.).
// ---------------------------------------------------------------------------

export function createSessionNotificationPlugin(): Plugin & {
  /** Convenience reference to the notification namespace. */
  readonly notifications: typeof _ns;
} {
  return {
    name: "session-notification",
    version: "0.1.0",

    setup(_ctx: PluginContext): void {
      // Plugin is intentionally stateless — the module-level store
      // handles all state.  Activation is a no-op but the plugin
      // descriptor exists so it participates in the lifecycle system.
    },

    teardown(): void {
      clearAll();
    },

    notifications: _ns,
  };
}

// ---------------------------------------------------------------------------
// _ns — internal namespace re-exporting all public functions.
//
// Exposed on the plugin descriptor so consumers can do:
//   plugin.notifications.sendNotification(...)
// ---------------------------------------------------------------------------

const _ns = {
  sendNotification,
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  clearSession,
  clearAll,
  listAllSessions,
  drainNotifications,
  formatNotificationsContext,
  notifyToolComplete,
  notifyToolError,
  notifyError,
  notifySessionEnd,
  notifySessionStart,
  notifyCompaction,
} as const;
